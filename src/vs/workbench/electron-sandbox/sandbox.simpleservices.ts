/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable code-no-standalone-editor */
/* eslint-disable code-import-patterns */

import { URI } from 'vs/base/common/uri';
import { InMemoryFileSystemProvider } from 'vs/platform/files/common/inMemoryFilesystemProvider';
import { Event } from 'vs/base/common/event';
import { IAddressProvider } from 'vs/platform/remote/common/remoteAgentConnection';
import { ExtensionKind } from 'vs/platform/extensions/common/extensions';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IExtensionService, NullExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { isWindows } from 'vs/base/common/platform';
import { IWebviewService, WebviewContentOptions, WebviewElement, WebviewExtensionDescription, WebviewOptions, WebviewOverlay } from 'vs/workbench/contrib/webview/browser/webview';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { AbstractTextFileService } from 'vs/workbench/services/textfile/browser/textFileService';
import { ITunnelProvider, ITunnelService, RemoteTunnel, TunnelProviderFeatures } from 'vs/platform/remote/common/tunnel';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { ISingleFolderWorkspaceIdentifier } from 'vs/platform/workspaces/common/workspaces';
import { ITaskProvider, ITaskService, ITaskSummary, ProblemMatcherRunOptions, Task, TaskFilter, TaskTerminateResponse, WorkspaceFolderTaskResult } from 'vs/workbench/contrib/tasks/common/taskService';
import { Action } from 'vs/base/common/actions';
import { LinkedMap } from 'vs/base/common/map';
import { IWorkspace, IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { CustomTask, ContributedTask, InMemoryTask, TaskRunSource, ConfiguringTask, TaskIdentifier, TaskSorter } from 'vs/workbench/contrib/tasks/common/tasks';
import { TaskSystemInfo } from 'vs/workbench/contrib/tasks/common/taskSystem';
import { joinPath } from 'vs/base/common/resources';
import { VSBuffer } from 'vs/base/common/buffer';
import { INativeWorkbenchConfiguration, INativeWorkbenchEnvironmentService } from 'vs/workbench/services/environment/electron-sandbox/environmentService';
import { NativeParsedArgs } from 'vs/platform/environment/common/argv';
import { IExtensionHostDebugParams } from 'vs/platform/environment/common/environment';
import type { IWorkbenchConstructionOptions } from 'vs/workbench/workbench.web.api';
import { Schemas } from 'vs/base/common/network';
import { TerminalInstanceService } from 'vs/workbench/contrib/terminal/browser/terminalInstanceService';
import { ITerminalInstanceService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { ConsoleLogger, LogService } from 'vs/platform/log/common/log';

//#region Environment

const userDataDir = URI.file('/sandbox-user-data-dir');

export class SimpleNativeWorkbenchEnvironmentService implements INativeWorkbenchEnvironmentService {

	declare readonly _serviceBrand: undefined;

	constructor(
		readonly configuration: INativeWorkbenchConfiguration
	) { }

	get userRoamingDataHome(): URI { return userDataDir.with({ scheme: Schemas.userData }); }
	get settingsResource(): URI { return joinPath(this.userRoamingDataHome, 'settings.json'); }
	get argvResource(): URI { return joinPath(this.userRoamingDataHome, 'argv.json'); }
	get snippetsHome(): URI { return joinPath(this.userRoamingDataHome, 'snippets'); }
	get globalStorageHome(): URI { return URI.joinPath(this.userRoamingDataHome, 'globalStorage'); }
	get workspaceStorageHome(): URI { return URI.joinPath(this.userRoamingDataHome, 'workspaceStorage'); }
	get keybindingsResource(): URI { return joinPath(this.userRoamingDataHome, 'keybindings.json'); }
	get logFile(): URI { return joinPath(this.userRoamingDataHome, 'window.log'); }
	get untitledWorkspacesHome(): URI { return joinPath(this.userRoamingDataHome, 'Workspaces'); }
	get serviceMachineIdResource(): URI { return joinPath(this.userRoamingDataHome, 'machineid'); }
	get userDataSyncLogResource(): URI { return joinPath(this.userRoamingDataHome, 'syncLog'); }
	get userDataSyncHome(): URI { return joinPath(this.userRoamingDataHome, 'syncHome'); }
	get userDataPath(): string { return userDataDir.fsPath; }
	get tmpDir(): URI { return joinPath(this.userRoamingDataHome, 'tmp'); }
	get logsPath(): string { return joinPath(this.userRoamingDataHome, 'logs').path; }

	sessionId = this.configuration.sessionId;
	machineId = this.configuration.machineId;
	remoteAuthority = this.configuration.remoteAuthority;
	os = { release: 'unknown' };

	options?: IWorkbenchConstructionOptions | undefined;
	logExtensionHostCommunication?: boolean | undefined;
	extensionEnabledProposedApi?: string[] | undefined;
	webviewExternalEndpoint: string = undefined!;
	webviewResourceRoot: string = undefined!;
	webviewCspSource: string = undefined!;
	skipReleaseNotes: boolean = undefined!;
	keyboardLayoutResource: URI = undefined!;
	sync: 'on' | 'off' | undefined;
	debugExtensionHost: IExtensionHostDebugParams = undefined!;
	debugRenderer = false;
	isExtensionDevelopment: boolean = false;
	disableExtensions: boolean | string[] = [];
	extensionDevelopmentLocationURI?: URI[] | undefined;
	extensionDevelopmentKind?: ExtensionKind[] | undefined;
	extensionTestsLocationURI?: URI | undefined;
	logLevel?: string | undefined;

	args: NativeParsedArgs = Object.create(null);

	execPath: string = undefined!;
	appRoot: string = undefined!;
	userHome: URI = undefined!;
	appSettingsHome: URI = undefined!;
	machineSettingsResource: URI = undefined!;

	log?: string | undefined;
	extHostLogsPath: URI = undefined!;

	installSourcePath: string = undefined!;

	extensionsPath: string = undefined!;
	extensionsDownloadPath: string = undefined!;
	builtinExtensionsPath: string = undefined!;

	driverHandle?: string | undefined;

	crashReporterDirectory?: string | undefined;
	crashReporterId?: string | undefined;

	nodeCachedDataDir?: string | undefined;

	verbose = false;
	isBuilt = false;

	get telemetryLogResource(): URI { return joinPath(this.userRoamingDataHome, 'telemetry.log'); }
	disableTelemetry = false;
}

//#endregion


//#region Workspace

export const simpleWorkspace: ISingleFolderWorkspaceIdentifier = { id: '4064f6ec-cb38-4ad0-af64-ee6467e63c82', uri: URI.file(isWindows ? '\\simpleWorkspace' : '/simpleWorkspace') };

//#endregion


//#region Logger

export class SimpleLogService extends LogService {

	constructor() {
		super(new ConsoleLogger());
	}

}

//#endregion


//#region Files

class SimpleFileSystemProvider extends InMemoryFileSystemProvider { }

export const simpleFileSystemProvider = new SimpleFileSystemProvider();

simpleFileSystemProvider.mkdir(userDataDir);

function createWorkspaceFile(parent: string, name: string, content: string = ''): void {
	simpleFileSystemProvider.writeFile(joinPath(simpleWorkspace.uri, parent, name), VSBuffer.fromString(content).buffer, { create: true, overwrite: true });
}

function createWorkspaceFolder(name: string): void {
	simpleFileSystemProvider.mkdir(joinPath(simpleWorkspace.uri, name));
}

createWorkspaceFolder('');
createWorkspaceFolder('src');
createWorkspaceFolder('test');

createWorkspaceFile('', '.gitignore', `out
node_modules
.vscode-test/
*.vsix
`);

createWorkspaceFile('', '.vscodeignore', `.vscode/**
.vscode-test/**
out/test/**
src/**
.gitignore
vsc-extension-quickstart.md
**/tsconfig.json
**/tslint.json
**/*.map
**/*.ts`);

createWorkspaceFile('', 'CHANGELOG.md', `# Change Log
All notable changes to the "test-ts" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]
- Initial release`);
createWorkspaceFile('', 'package.json', `{
	"name": "test-ts",
	"displayName": "test-ts",
	"description": "",
	"version": "0.0.1",
	"engines": {
		"vscode": "^1.31.0"
	},
	"categories": [
		"Other"
	],
	"activationEvents": [
		"onCommand:extension.helloWorld"
	],
	"main": "./out/extension.js",
	"contributes": {
		"commands": [
			{
				"command": "extension.helloWorld",
				"title": "Hello World"
			}
		]
	},
	"scripts": {
		"vscode:prepublish": "npm run compile",
		"compile": "tsc -p ./",
		"watch": "tsc -watch -p ./",
		"postinstall": "node ./node_modules/vscode/bin/install",
		"test": "npm run compile && node ./node_modules/vscode/bin/test"
	},
	"devDependencies": {
		"typescript": "^3.3.1",
		"vscode": "^1.1.28",
		"tslint": "^5.12.1",
		"@types/node": "^8.10.25",
		"@types/mocha": "^2.2.42"
	}
}
`);

createWorkspaceFile('', 'tsconfig.json', `{
	"compilerOptions": {
		"module": "commonjs",
		"target": "es6",
		"outDir": "out",
		"lib": [
			"es6"
		],
		"sourceMap": true,
		"rootDir": "src",
		"strict": true   /* enable all strict type-checking options */
		/* Additional Checks */
		// "noImplicitReturns": true, /* Report error when not all code paths in function return a value. */
		// "noFallthroughCasesInSwitch": true, /* Report errors for fallthrough cases in switch statement. */
		// "noUnusedParameters": true,  /* Report errors on unused parameters. */
	},
	"exclude": [
		"node_modules",
		".vscode-test"
	]
}
`);

createWorkspaceFile('', 'tslint.json', `{
	"rules": {
		"no-string-throw": true,
		"no-unused-expression": true,
		"no-duplicate-variable": true,
		"curly": true,
		"class-name": true,
		"semicolon": [
			true,
			"always"
		],
		"triple-equals": true
	},
	"defaultSeverity": "warning"
}
`);

createWorkspaceFile('src', 'extension.ts', `// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
		console.log('Congratulations, your extension "test-ts" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('extension.helloWorld', () => {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World!');
	});

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
`);

createWorkspaceFile('test', 'extension.test.ts', `//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
// import * as vscode from 'vscode';
// import * as myExtension from '../extension';

// Defines a Mocha test suite to group tests of similar kind together
suite("Extension Tests", function () {

	// Defines a Mocha unit test
	test("Something 1", function() {
		assert.equal(-1, [1, 2, 3].indexOf(5));
		assert.equal(-1, [1, 2, 3].indexOf(0));
	});
});`);

createWorkspaceFile('test', 'index.ts', `//
// PLEASE DO NOT MODIFY / DELETE UNLESS YOU KNOW WHAT YOU ARE DOING
//
// This file is providing the test runner to use when running extension tests.
// By default the test runner in use is Mocha based.
//
// You can provide your own test runner if you want to override it by exporting
// a function run(testRoot: string, clb: (error:Error) => void) that the extension
// host can call to run the tests. The test runner is expected to use console.log
// to report the results back to the caller. When the tests are finished, return
// a possible error to the callback or null if none.

import * as testRunner from 'vscode/lib/testrunner';

// You can directly control Mocha options by configuring the test runner below
// See https://github.com/mochajs/mocha/wiki/Using-mocha-programmatically#set-options
// for more info
testRunner.configure({
	ui: 'tdd', 		// the TDD UI is being used in extension.test.ts (suite, test, etc.)
	useColors: true // colored output from test results
});

module.exports = testRunner;`);

//#endregion


//#region Extensions

class SimpleExtensionService extends NullExtensionService { }

registerSingleton(IExtensionService, SimpleExtensionService);

//#endregion


//#region Webview

class SimpleWebviewService implements IWebviewService {
	declare readonly _serviceBrand: undefined;

	readonly activeWebview = undefined;

	createWebviewElement(id: string, options: WebviewOptions, contentOptions: WebviewContentOptions, extension: WebviewExtensionDescription | undefined): WebviewElement { throw new Error('Method not implemented.'); }
	createWebviewOverlay(id: string, options: WebviewOptions, contentOptions: WebviewContentOptions, extension: WebviewExtensionDescription | undefined): WebviewOverlay { throw new Error('Method not implemented.'); }
}

registerSingleton(IWebviewService, SimpleWebviewService);

//#endregion


//#region Textfiles

class SimpleTextFileService extends AbstractTextFileService {
	declare readonly _serviceBrand: undefined;
}

registerSingleton(ITextFileService, SimpleTextFileService);

//#endregion


//#region Tunnel

class SimpleTunnelService implements ITunnelService {

	declare readonly _serviceBrand: undefined;

	tunnels: Promise<readonly RemoteTunnel[]> = Promise.resolve([]);
	canElevate: boolean = false;
	canMakePublic = false;
	onTunnelOpened = Event.None;
	onTunnelClosed = Event.None;

	canTunnel(uri: URI): boolean { return false; }
	openTunnel(addressProvider: IAddressProvider | undefined, remoteHost: string | undefined, remotePort: number, localPort?: number): Promise<RemoteTunnel> | undefined { return undefined; }
	async changeTunnelPrivacy(remoteHost: string, remotePort: number, isPublic: boolean): Promise<RemoteTunnel | undefined> { return undefined; }
	async closeTunnel(remoteHost: string, remotePort: number): Promise<void> { }
	setTunnelProvider(provider: ITunnelProvider | undefined, features: TunnelProviderFeatures): IDisposable { return Disposable.None; }
}

registerSingleton(ITunnelService, SimpleTunnelService);

//#endregion


//#region Task

class SimpleTaskService implements ITaskService {

	declare readonly _serviceBrand: undefined;

	onDidStateChange = Event.None;
	supportsMultipleTaskExecutions = false;

	configureAction(): Action { throw new Error('Method not implemented.'); }
	build(): Promise<ITaskSummary> { throw new Error('Method not implemented.'); }
	runTest(): Promise<ITaskSummary> { throw new Error('Method not implemented.'); }
	run(task: CustomTask | ContributedTask | InMemoryTask | undefined, options?: ProblemMatcherRunOptions): Promise<ITaskSummary | undefined> { throw new Error('Method not implemented.'); }
	inTerminal(): boolean { throw new Error('Method not implemented.'); }
	isActive(): Promise<boolean> { throw new Error('Method not implemented.'); }
	getActiveTasks(): Promise<Task[]> { throw new Error('Method not implemented.'); }
	getBusyTasks(): Promise<Task[]> { throw new Error('Method not implemented.'); }
	restart(task: Task): void { throw new Error('Method not implemented.'); }
	terminate(task: Task): Promise<TaskTerminateResponse> { throw new Error('Method not implemented.'); }
	terminateAll(): Promise<TaskTerminateResponse[]> { throw new Error('Method not implemented.'); }
	tasks(filter?: TaskFilter): Promise<Task[]> { throw new Error('Method not implemented.'); }
	taskTypes(): string[] { throw new Error('Method not implemented.'); }
	getWorkspaceTasks(runSource?: TaskRunSource): Promise<Map<string, WorkspaceFolderTaskResult>> { throw new Error('Method not implemented.'); }
	readRecentTasks(): Promise<(CustomTask | ContributedTask | InMemoryTask | ConfiguringTask)[]> { throw new Error('Method not implemented.'); }
	getTask(workspaceFolder: string | IWorkspace | IWorkspaceFolder, alias: string | TaskIdentifier, compareId?: boolean): Promise<CustomTask | ContributedTask | InMemoryTask | undefined> { throw new Error('Method not implemented.'); }
	tryResolveTask(configuringTask: ConfiguringTask): Promise<CustomTask | ContributedTask | InMemoryTask | undefined> { throw new Error('Method not implemented.'); }
	getTasksForGroup(group: string): Promise<Task[]> { throw new Error('Method not implemented.'); }
	getRecentlyUsedTasks(): LinkedMap<string, string> { throw new Error('Method not implemented.'); }
	removeRecentlyUsedTask(taskRecentlyUsedKey: string): void { throw new Error('Method not implemented.'); }
	migrateRecentTasks(tasks: Task[]): Promise<void> { throw new Error('Method not implemented.'); }
	createSorter(): TaskSorter { throw new Error('Method not implemented.'); }
	getTaskDescription(task: CustomTask | ContributedTask | InMemoryTask | ConfiguringTask): string | undefined { throw new Error('Method not implemented.'); }
	canCustomize(task: CustomTask | ContributedTask): boolean { throw new Error('Method not implemented.'); }
	customize(task: CustomTask | ContributedTask | ConfiguringTask, properties?: {}, openConfig?: boolean): Promise<void> { throw new Error('Method not implemented.'); }
	openConfig(task: CustomTask | ConfiguringTask | undefined): Promise<boolean> { throw new Error('Method not implemented.'); }
	registerTaskProvider(taskProvider: ITaskProvider, type: string): IDisposable { throw new Error('Method not implemented.'); }
	registerTaskSystem(scheme: string, taskSystemInfo: TaskSystemInfo): void { throw new Error('Method not implemented.'); }
	registerSupportedExecutions(custom?: boolean, shell?: boolean, process?: boolean): void { throw new Error('Method not implemented.'); }
	setJsonTasksSupported(areSuppored: Promise<boolean>): void { throw new Error('Method not implemented.'); }
	extensionCallbackTaskComplete(task: Task, result: number | undefined): Promise<void> { throw new Error('Method not implemented.'); }
}

registerSingleton(ITaskService, SimpleTaskService);

//#endregion


//#region Terminal Instance

class SimpleTerminalInstanceService extends TerminalInstanceService { }

registerSingleton(ITerminalInstanceService, SimpleTerminalInstanceService);

//#endregion
