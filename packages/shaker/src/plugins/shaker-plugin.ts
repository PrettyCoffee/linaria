import type core from '@babel/core';
import type { BabelFile, PluginObj, NodePath, PluginPass } from '@babel/core';
import type { Binding } from '@babel/traverse';
import type {
  Identifier,
  MemberExpression,
  Program,
  VariableDeclarator,
} from '@babel/types';

import { createCustomDebug } from '@linaria/logger';
import type {
  EvaluatorConfig,
  Exports,
  IState,
  IMetadata,
} from '@linaria/utils';
import {
  applyAction,
  collectExportsAndImports,
  dereference,
  findActionForNode,
  getFileIdx,
  isFeatureEnabled,
  isRemoved,
  reference,
  removeDangerousCode,
  removeWithRelated,
  sideEffectImport,
} from '@linaria/utils';

import shouldKeepSideEffect from './utils/shouldKeepSideEffect';

type Core = typeof core;

export interface IShakerOptions
  extends Omit<EvaluatorConfig, 'highPriorityPlugins'> {
  keepSideEffects?: boolean;
  ifUnknownExport?: 'error' | 'ignore' | 'reexport-all' | 'skip-shaking';
}

interface NodeWithName {
  name: string;
}

function getBindingForExport(exportPath: NodePath): Binding | undefined {
  if (exportPath.isIdentifier()) {
    return exportPath.scope.getBinding(exportPath.node.name);
  }

  const variableDeclarator = exportPath.findParent((p) =>
    p.isVariableDeclarator()
  ) as NodePath<VariableDeclarator> | undefined;
  if (variableDeclarator) {
    const id = variableDeclarator.get('id');
    if (id.isIdentifier()) {
      return variableDeclarator.scope.getBinding(id.node.name);
    }
  }

  if (exportPath.isAssignmentExpression()) {
    const left = exportPath.get('left');
    if (left.isIdentifier()) {
      return exportPath.scope.getBinding(left.node.name);
    }
  }

  return undefined;
}

const withoutRemoved = <T extends { local: NodePath }>(items: T[]): T[] =>
  items.filter(({ local }) => !isRemoved(local));

function rearrangeExports(
  { types: t }: Core,
  root: NodePath<Program>,
  exportRefs: Map<string, NodePath<MemberExpression>[]>,
  exports: Exports
): Exports {
  const rearranged = {
    ...exports,
  };
  const rootScope = root.scope;
  exportRefs.forEach((refs, name) => {
    if (refs.length <= 1) {
      return;
    }

    const uid = rootScope.generateUid(name);
    // Define variable in the beginning
    const [declaration] = root.unshiftContainer('body', [
      t.variableDeclaration('var', [t.variableDeclarator(t.identifier(uid))]),
    ]);

    rootScope.registerDeclaration(declaration);

    // Replace every reference with defined variable
    refs.forEach((ref) => {
      const [replaced] = ref.replaceWith(t.identifier(uid));
      if (replaced.isBindingIdentifier()) {
        rootScope.registerConstantViolation(replaced);
      } else {
        reference(replaced);
      }
    });

    // Assign defined variable to the export
    const [pushed] = root.pushContainer('body', [
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(t.identifier('exports'), t.identifier(name)),
          t.identifier(uid)
        )
      ),
    ]);

    const local = pushed.get('expression.right') as NodePath<Identifier>;
    reference(local);

    rearranged[name] = local;
  });

  return rearranged;
}

export default function shakerPlugin(
  babel: Core,
  {
    deadImports = [],
    features,
    ifUnknownExport = 'skip-shaking',
    keepSideEffects = false,
    onlyExports,
    preeval,
  }: IShakerOptions
): PluginObj<PluginPass & IState & { file: { metadata: IMetadata } }> {
  return {
    name: '@linaria/shaker',
    visitor: {
      Program: {
        enter(programPath: NodePath<Program>) {
          // eslint-disable-next-line no-param-reassign
          this.file.metadata.linaria = preeval(babel, this.file);

          const filename = this.filename ?? this.file.opts.filename!;
          const log = createCustomDebug('shaker', getFileIdx(filename));

          log(
            'start',
            `${this.filename}, onlyExports: ${onlyExports.join(',')}`
          );
          const onlyExportsSet = new Set(onlyExports);

          const collected = collectExportsAndImports(programPath, true);
          const sideEffectImports = collected.imports.filter(sideEffectImport);
          log(
            'import-and-exports',
            [
              `imports: ${collected.imports.length} (side-effects: ${sideEffectImports.length})`,
              `exports: ${Object.keys(collected.exports).length}`,
              `reexports: ${collected.reexports.length}`,
            ].join(', ')
          );

          // We cannot just throw out exports if they are referred in the code
          // Let's dome some replacements
          const exports = rearrangeExports(
            babel,
            programPath,
            collected.exportRefs,
            collected.exports
          );

          Object.values(collected.exports).forEach((local) => {
            if (local.isAssignmentExpression()) {
              const left = local.get('left');
              if (left.isIdentifier()) {
                // For some reason babel does not mark id in AssignmentExpression as a reference
                // So we need to do it manually
                reference(left, left, true);
              }
            }
          });

          const hasLinariaPreval = exports.__linariaPreval !== undefined;
          const hasDefault = exports.default !== undefined;

          // If __linariaPreval is not exported, we can remove it from onlyExports
          if (onlyExportsSet.has('__linariaPreval') && !hasLinariaPreval) {
            onlyExportsSet.delete('__linariaPreval');
          }

          if (onlyExportsSet.size === 0) {
            // Fast-lane: if there are no exports to keep, we can just shake out the whole file
            this.imports = [];
            this.exports = {};
            this.reexports = [];
            this.deadExports = Object.keys(exports);

            programPath.get('body').forEach((p) => {
              p.remove();
            });

            return;
          }

          const importedAsSideEffect = onlyExportsSet.has('side-effect');
          onlyExportsSet.delete('side-effect');

          // Hackaround for packages which include a 'default' export without specifying __esModule; such packages cannot be
          // shaken as they will break interopRequireDefault babel helper
          // See example in shaker-plugin.test.ts
          // Real-world example was found in preact/compat npm package
          if (
            onlyExportsSet.has('default') &&
            hasDefault &&
            !collected.isEsModule
          ) {
            this.imports = collected.imports;
            this.exports = exports;
            this.reexports = collected.reexports;
            this.deadExports = [];
            return;
          }

          if (!onlyExportsSet.has('*')) {
            const aliveExports = new Set<NodePath>();
            const importNames = collected.imports.map(
              ({ imported }) => imported
            );

            Object.entries(exports).forEach(([exported, local]) => {
              if (onlyExportsSet.has(exported)) {
                aliveExports.add(local);
              } else if (
                importNames.includes((local.node as NodeWithName).name || '')
              ) {
                aliveExports.add(local);
              } else if ([...aliveExports].some((alive) => alive === local)) {
                // It's possible to export multiple values from a single variable initializer, e.g
                // export const { foo, bar } = baz();
                // We need to treat all of them as used if any of them are used, since otherwise
                // we'll attempt to delete the baz() call
                aliveExports.add(local);
              }
            });

            collected.reexports.forEach((exp) => {
              if (onlyExportsSet.has(exp.exported)) {
                aliveExports.add(exp.local);
              }
            });

            const isAllExportsFound = aliveExports.size === onlyExportsSet.size;
            if (!isAllExportsFound && ifUnknownExport !== 'ignore') {
              if (ifUnknownExport === 'error') {
                throw new Error(
                  `Unknown export(s) requested: ${onlyExports.join(',')}`
                );
              }

              if (ifUnknownExport === 'reexport-all') {
                // If there are unknown exports, we have keep alive all re-exports.
                if (exports['*'] !== undefined) {
                  aliveExports.add(exports['*']);
                }

                collected.reexports.forEach((exp) => {
                  if (exp.exported === '*') {
                    aliveExports.add(exp.local);
                  }
                });
              }

              if (ifUnknownExport === 'skip-shaking') {
                this.imports = collected.imports;
                this.exports = exports;
                this.reexports = collected.reexports;
                this.deadExports = [];

                return;
              }
            }

            if (isFeatureEnabled(features, 'dangerousCodeRemover', filename)) {
              log('dangerous-code', 'Strip all JSX and browser related stuff');
              removeDangerousCode(programPath);
            }

            const forDeleting = [
              ...Object.values(exports),
              ...collected.reexports.map((i) => i.local),
            ].filter((exp) => !aliveExports.has(exp));

            if (!keepSideEffects && !importedAsSideEffect) {
              // Remove all imports that don't import something explicitly and should not be kept
              sideEffectImports.forEach((i) => {
                if (!shouldKeepSideEffect(i.source)) {
                  forDeleting.push(i.local);
                }
              });
            }

            if (deadImports.length > 0) {
              collected.imports.forEach((i) => {
                if (i.imported === 'side-effect') {
                  return;
                }

                if (
                  deadImports.some(
                    (deadImport) =>
                      i.imported === deadImport.what &&
                      i.source === deadImport.from
                  )
                ) {
                  const binding = getBindingForExport(i.local);
                  if (!binding) {
                    forDeleting.push(i.local);
                    return;
                  }

                  forDeleting.push(...binding.referencePaths);
                }
              });
            }

            const deleted = new Set<NodePath>();

            const dereferenced: NodePath<Identifier>[] = [];
            let changed = true;
            while (changed && deleted.size < forDeleting.length) {
              changed = false;
              // eslint-disable-next-line no-restricted-syntax
              for (const path of forDeleting) {
                const binding = getBindingForExport(path);
                const action = findActionForNode(path);
                const parent = action?.[1];
                const outerReferences = (binding?.referencePaths || []).filter(
                  (ref) => ref !== parent && !parent?.isAncestor(ref)
                );
                if (outerReferences.length > 0 && path.isIdentifier()) {
                  // Temporary deref it in order to simplify further checks.
                  dereference(path);
                  dereferenced.push(path);
                }

                if (
                  !deleted.has(path) &&
                  (!binding || outerReferences.length === 0)
                ) {
                  if (action) {
                    applyAction(action);
                  } else {
                    removeWithRelated([path]);
                  }

                  deleted.add(path);
                  changed = true;
                }
              }
            }

            dereferenced.forEach((path) => {
              // If path is still alive, we need to reference it back
              if (!isRemoved(path)) {
                reference(path);
              }
            });
          }

          this.imports = withoutRemoved(collected.imports);
          this.exports = {};
          this.deadExports = [];
          Object.entries(exports).forEach(([exported, local]) => {
            if (isRemoved(local)) {
              this.deadExports.push(exported);
            } else {
              this.exports[exported] = local;
            }
          });

          this.reexports = withoutRemoved(collected.reexports);
        },
      },
    },
    post(file: BabelFile) {
      const log = createCustomDebug('shaker', getFileIdx(file.opts.filename!));

      const imports = new Map<string, string[]>();
      this.imports.forEach(({ imported, source }) => {
        if (!imports.has(source)) {
          imports.set(source, []);
        }

        if (imported) {
          imports.get(source)!.push(imported);
        }
      });

      this.reexports.forEach(({ imported, source }) => {
        if (!imports.has(source)) {
          imports.set(source, []);
        }

        imports.get(source)!.push(imported);
      });

      const exports = Object.keys(this.exports);

      log('end', `remaining exports: %o, imports: %O`, exports, imports);

      // eslint-disable-next-line no-param-reassign
      this.file.metadata.linariaEvaluator = {
        deadExports: this.deadExports,
        exports,
        imports,
      };
    },
  };
}
