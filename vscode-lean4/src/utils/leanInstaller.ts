import { window, TerminalOptions, OutputChannel, Disposable, EventEmitter, ProgressLocation, Uri } from 'vscode'
import { toolchainPath, addServerEnvPaths, getPowerShellPath, shouldAutofocusOutput, isRunningTest } from '../config'
import { batchExecute } from './batch'
import { readLeanVersion, isCoreLean4Directory } from './projectInfo';
import { join } from 'path';
import { logger } from './logger'

export class LeanVersion {
    version: string;
    error: string | undefined;
}

export class LeanInstaller implements Disposable {

    private leanInstallerLinux = 'https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh'
    private leanInstallerWindows = 'https://raw.githubusercontent.com/leanprover/elan/master/elan-init.ps1'
    private outputChannel: OutputChannel;
    private subscriptions: Disposable[] = [];
    private prompting : boolean = false;
    private defaultToolchain : string; // the default to use if there is no elan installed
    private elanDefaultToolchain : string = ''; // the default toolchain according to elan (toolchain marked with '(default)')
    private workspaceSuffix : string = '(workspace override)';
    private defaultSuffix : string = '(default)'
    private versionCache: Map<string,LeanVersion> = new Map();
    private promptUser : boolean = true;

    // This event is raised whenever a version change happens.
    // The event provides the workspace Uri where the change happened.
    private installChangedEmitter = new EventEmitter<Uri>();
    installChanged = this.installChangedEmitter.event

    constructor(outputChannel: OutputChannel, defaultToolchain : string) {
        this.outputChannel = outputChannel;
        this.defaultToolchain = defaultToolchain;
        if (isRunningTest()) {
            this.promptUser = false;
            if (process.env.LEAN4_PROMPT_USER === 'true'){
                this.promptUser = true;
            }
        }
    }

    getPromptUser() : boolean {
        return this.promptUser;
    }

    async testLeanVersion(packageUri: Uri) : Promise<LeanVersion> {

        // see if there is a lean-toolchain file and use that version info.
        let leanVersion : string | null = await readLeanVersion(packageUri);

        if (!leanVersion){
            const hasElan = await this.hasElan();
            if (!hasElan) {
                // Ah, there is no elan, but what if Lean is in the PATH due to custom install?
                const found = await this.checkLeanVersion(packageUri, leanVersion);
                if (found.error) {
                    return { version: '4', error: 'no elan installed' }
                }
            } else if (! await isCoreLean4Directory(packageUri)) {
                const defaultVersion = await this.getElanDefaultToolchain(packageUri);
                if (!defaultVersion) {
                    void this.showToolchainOptions(packageUri);
                } else {
                    leanVersion = defaultVersion;
                }
            }
        }

        const found = await this.checkLeanVersion(packageUri, leanVersion);
        if (found.error) {
            if (leanVersion){
                // if we have a lean-toolchain version or a workspace override then
                // use that version during the installElan process.
                this.defaultToolchain = leanVersion;
            }
            if (found.error === 'no default toolchain') {
                await this.showToolchainOptions(packageUri)
            }
        }
        return found;
    }

    async handleVersionChanged(packageUri : Uri) :  Promise<void> {
        if (packageUri && packageUri.scheme === 'file'){
            const key = packageUri.fsPath;
            if (this.versionCache.has(key)) {
                this.versionCache.delete(key);
            }
        }

        if (this.promptUser){
            if (this.prompting) {
                return;
            }
            const restartItem = 'Restart Lean';
            const item = await this.showPrompt('Lean version changed', restartItem);
            if (item === restartItem) {
                await this.checkAndFire(packageUri);
            }
        } else {
            await this.checkAndFire(packageUri);
        }
    }

    isPromptVisible(){
        return this.prompting;
    }

    private async showPrompt(message: string, ...items: string[]): Promise<string|undefined> {
        this.prompting = true;
        const item = await window.showErrorMessage(message, ...items);
        this.prompting = false;
        return item;
    }

    private async checkAndFire(packageUri : Uri) {
        const rc = await this.testLeanVersion(packageUri);
        if (rc.version === '4'){
            // it works, so restart the client!
            this.installChangedEmitter.fire(packageUri);
        }
    }

    async handleLakeFileChanged(uri: Uri) :  Promise<void> {
        if (this.promptUser){
            if (this.prompting) {
                return;
            }
            const restartItem = 'Restart Lean';
            const item = await this.showPrompt('Lake file configuration changed', restartItem);
            if (item === restartItem) {
                this.installChangedEmitter.fire(uri);
            }
        } else {
            this.installChangedEmitter.fire(uri);
        }
    }

    async showInstallOptions(uri: Uri) : Promise<void> {
        if (!this.promptUser){
            // no need to prompt when there is no user.
            return;
        }
        const path = toolchainPath();

        // note; we keep the LeanClient alive so that it can be restarted if the
        // user changes the Lean: Executable Path.
        const installItem = 'Install Lean using Elan';
        let prompt = 'Failed to start \'lean\' language server'
        if (path){
            prompt += ` from ${path}`
        }

        if (shouldAutofocusOutput()) {
            this.outputChannel.show(true);
        }

        const item = await this.showPrompt(prompt, installItem)
        if (item === installItem) {
            try {
                const result = await this.installElan();
                this.installChangedEmitter.fire(uri);
            } catch (err) {
                const msg = '' + err;
                logger.log(`[LeanInstaller] restart error ${msg}`);
                this.outputChannel.appendLine(msg);
            }
        }
    }

    private removeSuffix(version: string): string{
        let s = version;
        const suffixes = [this.defaultSuffix, this.workspaceSuffix];
        suffixes.forEach((suffix) => {
            if (s.endsWith(suffix)){
                s = s.substr(0, s.length - suffix.length);
            }
        });
        return s.trim();
    }

    async showToolchainOptions(uri: Uri) : Promise<void> {
        if (!this.promptUser){
            // no need to prompt when there is no user.
            return;
        }
        await window.showErrorMessage('You have no default "lean-toolchain" in this folder or any parent folder.')
    }

    async checkLeanVersion(packageUri: Uri | null, version: string | null): Promise<LeanVersion> {

        let cmd = toolchainPath();
        if (!cmd) {
            cmd = 'lean'
        } else {
            cmd = join(cmd, 'bin', 'lean')
        }
        const folderUri = packageUri ?? Uri.from({scheme: 'untitled'});
        const folderPath: string = folderUri.scheme === 'file' ? folderUri.fsPath : '';
        const cacheKey = folderUri.toString();
        if (this.versionCache.has(cacheKey)) {
            const result = this.versionCache.get(cacheKey);
            if (result){
                return result;
            }
        }

        const env = addServerEnvPaths(process.env);

        let options = ['--version']
        if (version) {
            // user is requesting an explicit version!
            options = ['+' + version, ...options]
        }

        const result : LeanVersion = { version: '', error: undefined }
        try {
            // If folderPath is undefined, this will use the process environment for cwd.
            // Specifically, if the extension was not opened inside of a folder, it
            // looks for a global (default) installation of Lean. This way, we can support
            // single file editing.
            logger.log(`executeWithProgress ${cmd} ${options}`)
            const stdout = await this.executeWithProgress('Checking Lean setup...', cmd, options, folderPath)
            if (!stdout) {
                result.error = 'lean not found'
            }
            else if (stdout.indexOf('no default toolchain') > 0) {
                result.error = 'no default toolchain'
            }
            else {
                const filterVersion = /version (\d+)\.\d+\..+/
                const match = filterVersion.exec(stdout)
                if (!match) {
                    return { version: '', error: `lean4: '${cmd} ${options}' returned incorrect version string '${stdout}'.` }
                }
                const major = match[1];
                result.version = major
            }
        } catch (err) {
            const msg = '' + err;
            logger.log(`[LeanInstaller] check lean version error ${msg}`);
            if (this.outputChannel) this.outputChannel.appendLine(msg);
            result.error = err
        }
        this.versionCache.set(cacheKey, result);
        return result
    }

    private async executeWithProgress(prompt: string, cmd: string, options: string[], workingDirectory: string | null): Promise<string>{
        let inc = 0;
        let stdout = ''
        /* eslint-disable  @typescript-eslint/no-this-alias */
        const realThis = this;
        await window.withProgress({
            location: ProgressLocation.Notification,
            title: '',
            cancellable: false
        }, (progress) => {
            const progressChannel : OutputChannel = {
                name : 'ProgressChannel',
                append(value: string)
                {
                    stdout += value;
                    if (realThis.outputChannel){
                        // add the output here in case user wants to go look for it.
                        const msg = value.trim();
                        logger.log(`[LeanInstaller] ${cmd} returned: ${msg}`);
                        realThis.outputChannel.appendLine(msg);
                    }
                    if (inc < 100) {
                        inc += 10;
                    }
                    progress.report({ increment: inc, message: value });
                },
                appendLine(value: string) {
                    this.append(value + '\n');
                },
                replace(value: string) { /* empty */ },
                clear() { /* empty */ },
                show() { /* empty */ },
                hide() { /* empty */ },
                dispose() { /* empty */ }
            }
            progress.report({increment:0, message: prompt});
            return batchExecute(cmd, options, workingDirectory, progressChannel);
        });
        return stdout;
    }

    getDefaultToolchain() : string {
        return this.defaultToolchain;
    }

    async getElanDefaultToolchain(packageUri: Uri): Promise<string> {
        if (this.elanDefaultToolchain){
            return this.elanDefaultToolchain;
        }

        const toolChains = await this.elanListToolChains(packageUri);
        let result :string = ''
        toolChains.forEach((s) => {
            if (s.endsWith(this.defaultSuffix)){
                result = this.removeSuffix(s);
            }
        });

        this.elanDefaultToolchain = result;
        return result;
    }

    async elanListToolChains(packageUri: Uri | null) : Promise<string[]> {

        let folderPath: string = ''
        if (packageUri) {
            folderPath = packageUri.fsPath
        }

        try {
            const cmd = 'elan';
            const options = ['toolchain', 'list'];
            const stdout = await batchExecute(cmd, options, folderPath, undefined);
            if (!stdout){
                throw new Error('elan toolchain list returned no output.');
            }
            const result : string[] = [];
            stdout.split(/\r?\n/).forEach((s) =>{
                s = s.trim()
                if (s !== '') {
                    result.push(s)
                }
            });
            return result;
        } catch (err) {
            return [`${err}`];
        }
    }

    async hasElan() : Promise<boolean> {
        let elanInstalled = false;
        // See if we have elan already.
        try {
            const options = ['--version']
            const stdout = await this.executeWithProgress('Checking Elan setup...', 'elan', options, null)
            const filterVersion = /elan (\d+)\.\d+\..+/
            const match = filterVersion.exec(stdout)
            if (match) {
                elanInstalled = true;
            }
        } catch (err) {
            elanInstalled = false;
        }
        return elanInstalled;
    }

    async installElan() : Promise<boolean> {

        if (toolchainPath()) {
            void window.showErrorMessage('It looks like you\'ve modified the `lean.toolchainPath` user setting.' +
            'Please clear this setting before installing elan.');
            return false;
        } else {
            const terminalName = 'Lean installation via elan';

            let terminalOptions: TerminalOptions = { name: terminalName };
            if (process.platform === 'win32') {
                terminalOptions = { name: terminalName, shellPath: getPowerShellPath() };
            }
            const terminal = window.createTerminal(terminalOptions);
            terminal.show();

            // We register a listener, to restart the Lean extension once elan has finished.
            const result = new Promise<boolean>(function(resolve, reject) {
                window.onDidCloseTerminal(async (t) => {
                if (t === terminal) {
                    resolve(true);
                } else {
                    logger.log('[LeanInstaller] ignoring terminal closed: ' + t.name + ', waiting for: ' + terminalName);
                }});
            });

            if (process.platform === 'win32') {
                terminal.sendText(
                    `Start-BitsTransfer -Source "${this.leanInstallerWindows}" -Destination "elan-init.ps1"\r\n` +
                    'Set-ExecutionPolicy -ExecutionPolicy Unrestricted -Scope Process\r\n' +
                    `$rc = .\\elan-init.ps1 -NoPrompt 1 -DefaultToolchain ${this.defaultToolchain}\r\n` +
                    'Write-Host "elan-init returned [$rc]"\r\n' +
                    'del .\\elan-init.ps1\r\n' +
                    'if ($rc -ne 0) {\r\n' +
                    '    Read-Host -Prompt "Press ENTER to continue"\r\n' +
                    '}\r\n' +
                    'exit\r\n'
                    );
            }
            else {
                const elanArgs = `-y --default-toolchain ${this.defaultToolchain}`;
                const prompt = '(echo && read -n 1 -s -r -p "Install failed, press ENTER to continue...")';

                terminal.sendText(`bash -c 'curl ${this.leanInstallerLinux} -sSf | sh -s -- ${elanArgs} || ${prompt}' && exit `);
            }

            // clear any previous lean version errors.
            this.versionCache.clear();
            this.elanDefaultToolchain = this.defaultToolchain;

            return result;
        }
    }

    dispose(): void {
        for (const s of this.subscriptions) { s.dispose(); }
    }
}
