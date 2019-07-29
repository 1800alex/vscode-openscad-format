const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");

const fs = require("fs");

const binPathCache = {};

function getBinPath(binname) {
	if(binPathCache[binname]) {
		return binPathCache[binname];
	}

	/* eslint-disable-next-line no-restricted-syntax */
	for(const binNameToSearch of correctBinname(binname)) {
		// openscad-format.executable has a valid absolute path
		if(fs.existsSync(binNameToSearch))
		{
			binPathCache[binname] = binNameToSearch;
			return binNameToSearch;
		}

		if(process.env.PATH)
		{
			const pathparts = process.env.PATH.split(path.delimiter);
			for(let i = 0; i < pathparts.length; i++) {
				const binpath = path.join(pathparts[i], binNameToSearch);
				if(fs.existsSync(binpath)) {
					binPathCache[binname] = binpath;
					return binpath;
				}
			}
		}
	}
	// Else return the binary name directly (this will likely always fail
	// downstream)
	binPathCache[binname] = binname;
	return binname;
}

function correctBinname(binname) {
	if("win32" === process.platform) {
		return[
			`${binname}.exe`,
			`${binname}.bat`,
			`${binname}.cmd`,
			binname
		];
	}
	return[binname];
}

exports.outputChannel = vscode.window.createOutputChannel("Openscad-Format");

class OpenscadDocumentFormattingEditProvider {
	constructor() {
		this.defaultConfigure = { executable: "openscad-format" };
	}

	provideDocumentFormattingEdits(document, options, token) {
		return this.formatDocument(document);
	}

	getEdits(document, stdout, codeContent) {
		return new Promise((resolve, reject) => {
			const edits = [];

			// todo a smarter diff would be nice
			const new_src = stdout.split(/\r?\n/);
			const old_src = codeContent.split(/\r?\n/);

			for(let i = 0; i < new_src.length; i++) {
				let diff = true;
				if(i < old_src.length) {
					if(new_src[i] === old_src[i]) {
						diff = false;
					} else{
						edits.push(vscode.TextEdit.delete(new vscode.Range(i, 0, i, old_src[i].length)));
					}
				}
				if(true === diff) {
					edits.push(vscode.TextEdit.insert(new vscode.Position(i, 0), new_src[i]));
				}
			}

			for(let i = new_src.length; i < old_src.length; i++) {
				edits.push(vscode.TextEdit.delete(new vscode.Range(i, 0, i, old_src[i].length)));
			}

			resolve(edits);
		});
	}

	/// Get execute name in openscad-format.executable, if not found, use default
	/// value If configure has changed, it will get the new value
	getExecutablePath() {
		const execPath = vscode.workspace.getConfiguration("openscad-format").get("executable");

		if(!execPath) {
			return this.defaultConfigure.executable;
		}

		// replace placeholders, if present
		return execPath.replace(/\${workspaceRoot}/g, vscode.workspace.rootPath)
			.replace(/\${cwd}/g, process.cwd())
			.replace(/\${env\.([^}]+)}/g, (sub, envName) => process.env[envName]);
	}

	getConfigPath() {
		const configPath = vscode.workspace.getConfiguration("openscad-format").get("config");

		if(!configPath) {
			return null;
		}

		// replace placeholders, if present
		return configPath.replace(/\${workspaceRoot}/g, vscode.workspace.rootPath)
			.replace(/\${cwd}/g, process.cwd())
			.replace(/\${env\.([^}]+)}/g, (sub, envName) => process.env[envName]);
	}

	doFormatDocument(document, range, options, token) {
		return new Promise((resolve, reject) => {
			const filename = document.fileName;
			const formatCommandBinPath = getBinPath(this.getExecutablePath());
			const configPath = this.getConfigPath();
			const codeContent = document.getText();
			const formatArgs = ["--dry", `--input=${filename}`];

			if(configPath) {
				formatArgs.push(`--config=${configPath}`);
			}

			let workingPath = vscode.workspace.rootPath;

			if(!document.isUntitled) {
				workingPath = path.dirname(filename);
			}

			let stdout = "";
			let stderr = "";
			const child = cp.spawn(formatCommandBinPath, formatArgs, { cwd: workingPath });
			child.stdin.end(codeContent);

			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});

			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			child.on("error", (err) => {
				if(err && "ENOENT" === err.code) {
					vscode.window.showInformationMessage(`The '${formatCommandBinPath}' command is not available. Please check your openscad-format.executable user setting and ensure it is installed.`);
					return resolve(null);
				}
				return reject(err);
			});

			child.on("close", (code) => {
				try{
					if(stderr.length !== 0) {
						exports.outputChannel.show();
						exports.outputChannel.clear();
						exports.outputChannel.appendLine(stderr);
						reject(new Error("Cannot format due to syntax errors."));
						return;
					}

					if(code !== 0) {
						reject();
						return;
					}

					resolve(this.getEdits(document, stdout, codeContent));
					return;
				} catch(e) {
					reject(e);
				}
			});
			if(token) {
				token.onCancellationRequested(() => {
					child.kill();
					reject(new Error("Cancelation requested"));
				});
			}
		});
	}

	formatDocument(document) {
		if(document.isDirty) {
			// Then save the document and make format
			document.save().then(() => ([]));
			return([]);
		}

		return this.doFormatDocument(document, null, null, null);
	}
}
const languages = ["scad"];
const MODES = languages.map(language => ({
	language,
	scheme: "file"
}));

function activate(ctx) {
	const formatter = new OpenscadDocumentFormattingEditProvider();
	const availableLanguages = {};
	MODES.forEach((mode) => {
		ctx.subscriptions.push(
			vscode.languages.registerDocumentFormattingEditProvider(
				mode, formatter
			)
		);
		availableLanguages[mode.language] = true;
	});
}

exports.activate = activate;
