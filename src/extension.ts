'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as sanitize from 'sanitize-filename';
import {fuzzyDefinitionSearch} from './search';
import {AlanTreeViewDataProvider} from './providers/AlanTreeView'

//This extension is based on Fuzzy Definitions from Johannes Rieken

export function deactivate(context: vscode.ExtensionContext) {
    vscode.commands.executeCommand('setContext', 'isAlanFile', false);
}

export function activate(context: vscode.ExtensionContext) {
    let registrations: vscode.Disposable[] = [];

    function checkState() {
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId == "alan") {
            vscode.commands.executeCommand('setContext', 'isAlanFile', true);
        } else {
            vscode.commands.executeCommand('setContext', 'isAlanFile', false);
        }
    }
    checkState();

    registrations.push(vscode.commands.registerTextEditorCommand('editor.gotoAlanDefinitions', editor => {
        let {document, selection} = editor;

        return fuzzyDefinitionSearch(document, selection.active, new vscode.CancellationTokenSource().token).then(locations => {
            if (!locations || locations.length === 0) {
                let range = document.getWordRangeAtPosition(selection.active);
                let message = range ? 'unable to find' : 'unable to find ' + document.getText(range);
                vscode.window.setStatusBarMessage(message, 1500);
                return;
            }

            if (locations.length === 1) {
                return openLocation(locations[0]);
            }

            let picks = locations.map(l => ({
                label: `${vscode.workspace.asRelativePath(l.uri)}:${l.range.start.line + 1}`,
                description: l.uri.fsPath,
                location: l
            }));

            return vscode.window.showQuickPick(picks).then(pick => {
                return pick && openLocation(pick.location);
            });
        });
    }));

    // pretend to be a definition provider
    if (vscode.workspace.getConfiguration('alan-definitions').get<boolean>('integrateWithGoToDefinition')) {
        registrations.push(vscode.languages.registerDefinitionProvider(
            'alan', {
                provideDefinition: fuzzyDefinitionSearch
            }
        ));
    }

    registrations.push(vscode.commands.registerCommand('input.migration.name', async function () {
        const bash_shell = resolveBashShell();
        const active_file_name = vscode.window.activeTextEditor.document.fileName;
        const active_file_dirname = path.dirname(active_file_name);

        return new Promise(resolve => {
            resolveAlanRoot(active_file_dirname).then(alan_root => {
                vscode.window.showInputBox({
                    value: 'from_empty',
                    valueSelection: [5,10],
                    placeHolder: `For example: <git commit id of 'from' model>`
                }).then(migration_name_raw => {
                    const migration_name = sanitize(migration_name_raw);
                    resolve(normalizePath(`${alan_root}/migrations/${migration_name}`, bash_shell));
                });
            });
        });
    }));

    registrations.push(vscode.commands.registerCommand('input.migration.model', async function () {
        const bash_shell = resolveBashShell();
        const active_file_name = vscode.window.activeTextEditor.document.fileName;
        const active_file_dirname = path.dirname(active_file_name);

        return new Promise(resolve => {
            resolveAlanRoot(active_file_dirname).then(alan_root => {
                const systems_dirs = fs.readdirSync(path.join(alan_root, "systems"))
                    .map(system => path.join(system, "model.lib.link"))
                    .filter(modellib => fs.existsSync(path.join(alan_root, "systems", modellib)));

                vscode.window.showQuickPick(systems_dirs, {
                    placeHolder: 'migration target model'
                }).then(migration_model => {
                    resolve(normalizePath(`${alan_root}/systems/${migration_model}`, bash_shell));
                });
            });
        });

    }));

    registrations.push(vscode.commands.registerCommand('input.migration.type', async function () {
        const migration_type_bootstrap = "initialization from empty dataset";
        const migration_type = await vscode.window.showQuickPick([
            migration_type_bootstrap,
            "mapping from target conformant dataset"
        ], {
            placeHolder: 'migration type'
        });

        return `${migration_type === migration_type_bootstrap ? "--bootstrap" : ""}`
    }));

    registrations.push(vscode.tasks.registerTaskProvider('alan', {
        provideTasks: () => {
            const bash_shell = resolveBashShell();
            return getAlanTasks(bash_shell);
        },
        resolveTask(task: vscode.Task): vscode.Task | undefined {
            return undefined;
        }
    }));

    registrations.push(vscode.window.registerTreeDataProvider(
        "alanTreeView",
        new AlanTreeViewDataProvider(context)
    ));

    context.subscriptions.push(...registrations);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            checkState();
        }, null, context.subscriptions )
    );
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(() => {
            checkState();
        }, null, context.subscriptions )
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(() => {
            if (vscode.window.visibleTextEditors.length < 1) {
                vscode.commands.executeCommand('setContext', 'isAlanFile', false);
            }
        }, null, context.subscriptions )
    );
}

function openLocation(location: vscode.Location) {
    return vscode.workspace.openTextDocument(location.uri).then(doc => {
        return vscode.window.showTextDocument(doc).then(editor => {
            editor.revealRange(location.range);
        });
    });
}

function exists(file: string): Promise<boolean> {
    return new Promise<boolean>((resolve, _reject) => {
        fs.exists(file, (value) => {
            resolve(value);
        });
    });
}

const wsl = "C:\\Windows\\System32\\wsl.exe";
const wsl_bash = "c:\\windows\\sysnative\\bash.exe";
const git_bash_x64 = "C:\\Program Files\\Git\\bin\\bash.exe"
const git_bash_x32 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe"

function isWsl(shell: string) {
    return shell == wsl_bash;
}
function normalizePath(path : string, shell: string) {
    return path
        .replace(/([a-zA-Z]):/, isWsl(shell) ? "/mnt/$1" : "$1:") // replace drive: with /mnt/drive for WSL
        .replace(/\\/g, '/') //  convert backslashes from windows paths
        .replace(/ /g, '\\ '); // escape spaces
}

function resolveBashShell() : string {
    const shell: string = vscode.workspace.getConfiguration('alan-definitions').get<string>('taskShell')
    if (shell && shell !== null && shell !== "") {
        return shell;
    } else if (process.platform === 'win32') {
        if (fs.existsSync(wsl)) {
            return wsl_bash;
        } else if (fs.existsSync(git_bash_x64)) {
            return git_bash_x64;
        } else if (fs.existsSync(git_bash_x32)) {
            return git_bash_x32;
        } else {
            let error = "Could not locate a bash shell for executing Alan tasks. Please set one in the extension's settings.";
            const selectedItem = vscode.window.showErrorMessage(error);
            return undefined;
        }
    } else {
        return undefined; //fallback to default
    }
}

async function resolveAlanRoot(file_dir: string) : Promise<string> {
    const {root} = path.parse(file_dir);

    return new Promise((resolve, reject) => {
        (async function find(curdir) {
            let alan_file = path.join(curdir, "alan");
            if (curdir === root) {
                reject(null);
            } else if (!await exists(alan_file)) {
                find(path.dirname(curdir));
            } else {
                return resolve(curdir);
            }
        })(file_dir);
    });
}

async function getAlanTasks(shell: string): Promise<vscode.Task[]> {
    const workspace_root = vscode.workspace.rootPath;
    const active_file_name = vscode.window.activeTextEditor.document.fileName;
    const active_file_dirname = path.dirname(active_file_name);
    const active_file_dirname_bash = normalizePath(active_file_dirname, shell);

    let empty_tasks: vscode.Task[] = [];
    if (!workspace_root) {
        return empty_tasks;
    }

    return new Promise(resolve => {
        resolveAlanRoot(active_file_dirname).then(alan_root => {
            const alan_root_folder = normalizePath(alan_root, shell);
            const alan = normalizePath(`${alan_root}/alan`, shell);
            const wsl_convert = isWsl(shell) ? " | sed -e 's@/mnt/\\([a-z]\\)@\\1:@g'" : "";
            const convert_output = ` 2>&1 | sed ':begin;$!N;s@\\n\\t\\+@ @;tbegin;P;D'${wsl_convert}`; //hack while vscode does not support it via a problemmatcher

            const result: vscode.Task[] = [];
            const default_options: vscode.ShellExecutionOptions = {
                "executable": shell, //custom or default
                "cwd": "${fileDirname}",
                "shellArgs": ["-c"]
            };
            const problemMatchers = ["$alanc-range", "$alanc-lc"];

            const fetch_task = new vscode.Task({
                type: 'alan',
                task: "fetch"
            }, "fetch", "alan", new vscode.ShellExecution(`${alan} fetch`, default_options), problemMatchers);
            fetch_task.group = vscode.TaskGroup.Clean; //??
            fetch_task.presentationOptions = {
                "clear": true,
                "reveal": vscode.TaskRevealKind.Always,
                "showReuseMessage": false,
                "focus": false
            };

            const build_task = new vscode.Task({
                type: 'alan',
                task: "build"
            }, "build", "alan", new vscode.ShellExecution(`${alan} build${convert_output}`, default_options), problemMatchers);
            build_task.group = vscode.TaskGroup.Build;
            build_task.presentationOptions = {
                "clear": true,
                "reveal": vscode.TaskRevealKind.Always,
                "showReuseMessage": false,
                "focus": false
            };

            const migration_task = new vscode.Task({
                type: 'alan',
                task: "generate migration"
            }, "generate migration", "alan", new vscode.ShellExecution(`${alan_root_folder}/.alan/dataenv/system-types/datastore/scripts/generate_migration.sh`, [
                "${command:input.migration.name}",
                "${command:input.migration.model}",
                "${command:input.migration.type}"
            ], default_options), problemMatchers);
            migration_task.group = vscode.TaskGroup.Clean; //??
            migration_task.presentationOptions = {
                "clear": true,
                "reveal": vscode.TaskRevealKind.Always,
                "showReuseMessage": false,
                "focus": false
            };

            result.push(fetch_task);
            result.push(build_task);
            result.push(migration_task);

            if (path.basename(active_file_name) === "connections.alan") {
                const package_task = new vscode.Task({
                    type: 'alan',
                    task: "package"
                }, "package", "alan", new vscode.ShellExecution(`./alan package ./dist/project.pkg ${active_file_dirname_bash}${convert_output}`, default_options), problemMatchers);
                package_task.execution.options.cwd = alan_root_folder;
                package_task.group = vscode.TaskGroup.Build;
                package_task.presentationOptions = {
                    "clear": true,
                    "reveal": vscode.TaskRevealKind.Always,
                    "showReuseMessage": false,
                    "focus": false
                };
                result.push(package_task);
            }

            resolve(result);
        }, () => resolve([]));
    });
}