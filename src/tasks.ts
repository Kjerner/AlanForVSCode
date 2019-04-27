'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as proc from 'child_process';
import * as stripAnsiStream from 'strip-ansi-stream';
import * as sanitize from 'sanitize-filename';

const wsl = 'C:\\Windows\\System32\\wsl.exe';
const wsl_bash = 'C:\\Windows\\System32\\bash.exe';
const git_bash_x64 = 'C:\\Program Files\\Git\\bin\\bash.exe';
const git_bash_x32 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
const linux_osx_bash = '/bin/bash';

function isWsl(shell: string) {
	return shell == wsl_bash;
}
function pathToBashPath(path : string, shell: string) {
	return path
		.replace(/([a-zA-Z]):/, isWsl(shell) ? '/mnt/$1' : '$1:') // replace drive: with /mnt/drive for WSL
		.replace(/\\/g, '/') //  convert backslashes from windows paths
		.replace(/ /g, '\\ '); // escape spaces
}
function bashPathsToWinPaths(string: string, shell: string) {
	if (isWsl(shell)) {
		return string.replace(/\/mnt\/([a-z])\//g, '$1:/');
	}
	return string;
}
function exists(file: string): Promise<boolean> {
	return new Promise<boolean>((resolve, _reject) => {
		fs.exists(file, (value) => {
			resolve(value);
		});
	});
}
async function resolveBashShell() : Promise<string> {
	const shell: string = vscode.workspace.getConfiguration('alan-definitions').get<string>('taskShell')
	if (shell && shell !== null && shell !== '') {
		return shell;
	} else if (process.platform === 'win32') {
		if (await exists(wsl)) {
			return wsl_bash;
		} else if (await exists(git_bash_x64)) {
			return git_bash_x64;
		} else if (await exists(git_bash_x32)) {
			return git_bash_x32;
		} else {
			let error = 'Could not locate a bash shell for executing Alan tasks. Please set one in the extension\'s settings.';
			vscode.window.showErrorMessage(error);
			return undefined;
		}
	} else {
		return linux_osx_bash;
	}
}

function executeCommand(shell_command: string, cwd: string, shell: string, output_channel: vscode.OutputChannel, diagnostics_collection: vscode.DiagnosticCollection) {
    output_channel.clear();
    output_channel.show(true);
    diagnostics_collection.clear();

    const child: proc.ChildProcess|undefined
        = proc.spawn(shell, ['-c', shell_command], { cwd: cwd });

	if (child) {
		child.on('error', err => {
            const error = `Failure executing command '${shell_command}'.`;
            output_channel.appendLine(error);
		});

		let output_acc = '';

		const stripped_stream = stripAnsiStream();
		stripped_stream.on('data', data => {
			const string: string = bashPathsToWinPaths(data.toString(), shell);
			output_channel.append(string);
			output_acc += string;
		});

		child.stdout.pipe(stripped_stream);
		child.stderr.pipe(stripped_stream);

		child.on('close', retc => {
			const diagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [];

			{ // output parser
				let current_diagnostic: vscode.Diagnostic | undefined;
				const lines: String[] = output_acc.split('\n');
				lines.forEach((line) => {
					function getSeverity(severity: string): vscode.DiagnosticSeverity {
						return severity == 'error' ?
							vscode.DiagnosticSeverity.Error : severity === 'warning' ?
								vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information
					}

					const re_range: RegExp = /^((?:\/|[a-zA-Z]:).*\.alan) from ([0-9]+):([0-9]+) to ([0-9]+):([0-9]+) (error|warning|info): (.*)/;
                    {
                        const range_match = line.match(re_range);
                        if (range_match) {
                            const file = vscode.Uri.file(range_match[1]);
                            const line = parseInt(range_match[2], 10);
                            const column = parseInt(range_match[3], 10);
                            const endLine = parseInt(range_match[4], 10);
                            const endColumn = parseInt(range_match[5], 10);
                            const severity = range_match[6];
                            const message = range_match[7];

                            const range = new vscode.Range(line - 1, column - 1, endLine - 1, endColumn - 1);
                            current_diagnostic = new vscode.Diagnostic(range, message, getSeverity(severity));
                            diagnostics.push([file, [current_diagnostic]]);
                            return;
                        }
                    }

					const re_locat: RegExp = /^((?:\/|[a-zA-Z]:).*\.alan) at ([0-9]+):([0-9]+) (error|warning|info): (.*)/;
                    {
                        const locat_match = line.match(re_locat);
                        if (locat_match) {
                            const file = vscode.Uri.file(locat_match[1]);
                            const line = parseInt(locat_match[2], 10);
                            const column = parseInt(locat_match[3], 10);
                            const severity = locat_match[4];
                            const message = locat_match[5];

                            const range = new vscode.Range(line - 1, column - 1, line - 1, column - 1);
                            current_diagnostic = new vscode.Diagnostic(range, message, getSeverity(severity));
                            diagnostics.push([file, [current_diagnostic]]);
                            return;
                        }
                    }

                    const re_link: RegExp = /^((?:\/|[a-zA-Z]:).*\.link) (error|warning|info): (.*)/;
                    {
                        const link_match = line.match(re_link);
                        if (link_match) {
                            const file = vscode.Uri.file(link_match[1]);
                            const severity = link_match[2];
                            const message = link_match[3];

                            const range = new vscode.Range(0, 0, 0, 0);
                            current_diagnostic = new vscode.Diagnostic(range, message, getSeverity(severity));
                            diagnostics.push([file, [current_diagnostic]]);
                            return;
                        }
                    }

                    const re_other: RegExp = /^((?:\/|[a-zA-Z]:).*\.alan) (error|warning|info): (.*)/;
                    {
                        const other_match = line.match(re_other);
                        if (other_match) {
                            const file = vscode.Uri.file(other_match[1]);
                            const severity = other_match[2];
                            const message = other_match[3];

                            const range = new vscode.Range(0, 0, 0, 0);
                            current_diagnostic = new vscode.Diagnostic(range, message, getSeverity(severity));
                            diagnostics.push([file, [current_diagnostic]]);
                            return;
                        }
                    }

					if (current_diagnostic && line.startsWith('\t')) {
						current_diagnostic.message += '\n' + line;
					}
				});
			}

			diagnostics_collection.set(diagnostics);
		});
	} else {
        const error = `Unable to execute command '${shell_command}'.`;
        output_channel.appendLine(error);
	}
}

async function getMigrationName(shell: string, alan_root: string): Promise<string> {
	return new Promise(resolve => {
		vscode.window.showInputBox({
			value: 'from_empty',
			valueSelection: [5,10],
			placeHolder: `For example: <git commit id of 'from' model>`
		}).then(migration_name_raw => {
			const migration_name = sanitize(migration_name_raw);
			resolve(pathToBashPath(`${alan_root}/migrations/${migration_name}`, shell));
		});
	});
}
async function getMigrationModel(shell: string, alan_root: string): Promise<string> {
	return new Promise(resolve => {
		const systems_dirs = fs.readdirSync(path.join(alan_root, 'systems'))
			.map(system => path.join(system, 'model.lib.link'))
			.filter(modellib => fs.existsSync(path.join(alan_root, 'systems', modellib)));

		vscode.window.showQuickPick(systems_dirs, {
			placeHolder: 'migration target model'
		}).then(migration_model => {
			resolve(pathToBashPath(`${alan_root}/systems/${migration_model}`, shell));
		});
	});
}
async function getMigrationType(): Promise<string> {
	const migration_type_bootstrap = 'initialization from empty dataset';
	const migration_type = await vscode.window.showQuickPick([
		migration_type_bootstrap,
		'mapping from target conformant dataset'
	], {
		placeHolder: 'migration type'
	});

	return migration_type === migration_type_bootstrap ? '--bootstrap' : '';
}

export async function generateMigration(output_channel: vscode.OutputChannel, diagnostics_collection: vscode.DiagnosticCollection) {
	const shell = await resolveBashShell();

	const active_file_name = vscode.window.activeTextEditor.document.fileName;
	const active_file_dirname = path.dirname(active_file_name);
	const alan_root = await resolveAlanRoot(active_file_dirname);
	const alan_root_folder = pathToBashPath(alan_root, shell);

	const name = await getMigrationName(shell, alan_root);
	const model = await getMigrationModel(shell, alan_root);
	const type = await getMigrationType();

	executeCommand(
		`${alan_root_folder}/.alan/dataenv/system-types/datastore/scripts/generate_migration.sh ${name} ${model} ${type}`,
		active_file_dirname,
		shell,
		output_channel,
		diagnostics_collection);
}

export async function build(output_channel: vscode.OutputChannel, diagnostics_collection: vscode.DiagnosticCollection) {
	const shell = await resolveBashShell();

	const active_file_name = vscode.window.activeTextEditor.document.fileName;
	const active_file_dirname = path.dirname(active_file_name);
	const alan_root = await resolveAlanRoot(active_file_dirname);
	const alan = pathToBashPath(`${alan_root}/alan`, shell);

	executeCommand(`${alan} build`, active_file_dirname, shell, output_channel, diagnostics_collection);
}

export async function package_deployment(output_channel: vscode.OutputChannel, diagnostics_collection: vscode.DiagnosticCollection) {
	const shell = await resolveBashShell();

	const active_file_name = vscode.window.activeTextEditor.document.fileName;
	const active_file_dirname = path.dirname(active_file_name);
	const active_file_dirname_bash = pathToBashPath(active_file_dirname, shell);
	const alan_root = await resolveAlanRoot(active_file_dirname);

	executeCommand(`./alan package ./dist/project.pkg ${active_file_dirname_bash}`, alan_root, shell, output_channel, diagnostics_collection);
}

async function resolveAlanRoot(file_dir: string) : Promise<string> {
	const {root} = path.parse(file_dir);

	return new Promise((resolve, reject) => {
		(async function find(curdir) {
			const alan_file = path.join(curdir, 'alan');
			if (curdir === root) {
				reject(undefined);
			} else if (!await exists(alan_file)) {
				find(path.dirname(curdir));
			} else {
				return resolve(curdir);
			}
		})(file_dir);
	});
}

export async function getTasksList(): Promise<vscode.Task[]> {
	const workspace_root = vscode.workspace.rootPath;
	if (!workspace_root) return [];

	try {
		const shell = await resolveBashShell();
		const active_file_name = vscode.window.activeTextEditor.document.fileName;
		const active_file_dirname = path.dirname(active_file_name);
		const alan_root = await resolveAlanRoot(active_file_dirname);
		const alan_root_folder = pathToBashPath(alan_root, shell);
		const alan = pathToBashPath(`${alan_root}/alan`, shell);

		const result: vscode.Task[] = [];
		const default_options: vscode.ShellExecutionOptions = {
			'executable': shell, //custom or default
			'cwd': '${fileDirname}',
			'shellArgs': ['-c']
		};
		const no_problem_matchers = []; // prevent popup to scan task output

		const fetch_task = new vscode.Task({
			'type': 'alan',
			'task': 'fetch'
		}, 'fetch','alan', new vscode.ShellExecution(`${alan} fetch`, default_options), no_problem_matchers);
		fetch_task.group = vscode.TaskGroup.Clean; //??
		fetch_task.presentationOptions = {
			'clear': true,
			'reveal': vscode.TaskRevealKind.Always,
			'showReuseMessage': false,
			'focus': false
		};

		const build_task = new vscode.Task({
			'type': 'alan',
			'task': 'build'
		}, 'build','alan', new vscode.ShellExecution('${command:alan.tasks.build}', default_options), no_problem_matchers);
		build_task.group = vscode.TaskGroup.Build;

		const migration_task = new vscode.Task({
			'type': 'alan',
			'task': 'generate migration'
		}, 'generate migration', 'alan', new vscode.ShellExecution('${command:alan.tasks.generateMigration}', default_options), no_problem_matchers);
		migration_task.group = vscode.TaskGroup.Clean; //??

		result.push(fetch_task);
		result.push(build_task);
		result.push(migration_task);

		if (path.basename(active_file_name) === 'connections.alan') {
			const package_task = new vscode.Task({
				'type': 'alan',
				'task': 'package'
			}, 'package', 'alan', new vscode.ShellExecution('${command:alan.tasks.package}', default_options), no_problem_matchers);
			package_task.execution.options.cwd = alan_root_folder;
			package_task.group = vscode.TaskGroup.Build;
			result.push(package_task);
		}

		return result;
	} catch {
		return [];
	}
}