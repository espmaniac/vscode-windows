const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

let panel = null;
let manuallyClosed = false; // Flag: panel closed by user

function activate(context) {

  async function createMonacoWindow(fileUri) {
    if (manuallyClosed) return; // If the panel was closed by the user, do not create a new one

    const fileName = path.basename(fileUri.fsPath || 'Untitled');
    let fileText = '';

    try {
      if (fileUri.scheme === 'untitled') {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
        fileText = doc ? doc.getText() : '';
      } else {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
        fileText = doc ? doc.getText() : fs.readFileSync(fileUri.fsPath, 'utf8');
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error opening file: ${error.message}`);
      return;
    }

    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'floatingMonacoEditor',
        "Windows",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );

      panel.onDidDispose(() => {
        panel = null;
        manuallyClosed = true; // The user closed the panel
      });

      const htmlPath = vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview.html'));

      fs.readFile(htmlPath.fsPath, 'utf8', (err, data) => {
        if (err) {
          vscode.window.showErrorMessage("Error loading webview HTML: " + err.message);
          return;
        }

        panel.webview.html = data;

        // Add all open documents to the webview
        vscode.workspace.textDocuments.forEach(doc => {
          panel.webview.postMessage({
            type: 'init',
            id: doc.uri.toString(),
            name: path.basename(doc.uri.fsPath || 'Untitled'),
            text: doc.getText()
          });
        });
      });

      // Handle messages from the webview
      panel.webview.onDidReceiveMessage(message => {
        if (message.type === 'edit') {
          try {
            const uri = vscode.Uri.parse(message.id);
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            if (doc) {
              const edit = new vscode.WorkspaceEdit();
              const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
              );
              edit.replace(uri, fullRange, message.text);
              vscode.workspace.applyEdit(edit); // Mark the document as dirty in VS Code
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Error editing file: ${err.message}`);
          }
        }
      });

      const sendTheme = () => { panel?.webview.postMessage({ type: 'themeColors' }); };
      sendTheme();
      vscode.window.onDidChangeActiveColorTheme(sendTheme);

    } else {
      // If the panel already exists, just add the file
      panel.webview.postMessage({
        type: 'init',
        id: fileUri.toString(),
        name: fileName,
        text: fileText
      });
    }
  }

  // Command to manually open the webview
  const disposable = vscode.commands.registerCommand('extension.openWindows', () => {
    manuallyClosed = false; // The user explicitly opened the panel
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) createMonacoWindow(activeEditor.document.uri);
  });
  context.subscriptions.push(disposable);

  // Auto-opening for the active editor
  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor && !panel) createMonacoWindow(editor.document.uri);
  });

  // New files created
  vscode.workspace.onDidCreateFiles(e => e.files.forEach(uri => createMonacoWindow(uri)));

  // Documents opened
  vscode.workspace.onDidOpenTextDocument(doc => createMonacoWindow(doc.uri));

  // Files closed
  vscode.workspace.onDidCloseTextDocument(doc => {
    if (panel) {
      panel.webview.postMessage({ type: 'close', id: doc.uri.toString() });
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };