const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

let panel = null;
let manuallyClosed = false;

function activate(context) {

  async function createMonacoWindow(fileUri) {
    if (manuallyClosed) return;

    const fileName = path.basename(fileUri.fsPath || 'Untitled');
    let fileText = '';

    try {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
      fileText = doc ? doc.getText() : '';
    } catch (error) {
      vscode.window.showErrorMessage(`Error opening file: ${error.message}`);
      return;
    }

    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'floatingMonacoEditor',
        'Windows',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      panel.onDidDispose(() => {
        panel = null;
        manuallyClosed = true;
      });

      const htmlPath = vscode.Uri.file(
        path.join(context.extensionPath, 'src', 'webview.html')
      );

      panel.webview.html = fs.readFileSync(htmlPath.fsPath, 'utf8');

      // Send all currently opened documents
      vscode.workspace.textDocuments.forEach(doc => {
        panel.webview.postMessage({
          type: 'init',
          id: doc.uri.toString(),
          name: path.basename(doc.uri.fsPath || 'Untitled'),
          text: doc.getText()
        });
      });

      // Messages FROM webview (Monaco → VS Code)
      panel.webview.onDidReceiveMessage(message => {
        if (message.type === 'edit' && message.source === 'monaco') {
          const uri = vscode.Uri.parse(message.id);
          const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
          if (!doc) return;

          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
          );

          edit.replace(uri, fullRange, message.text);
          vscode.workspace.applyEdit(edit);
        }
      });

      // Theme sync
      const sendTheme = () => panel?.webview.postMessage({ type: 'themeColors' });
      sendTheme();
      vscode.window.onDidChangeActiveColorTheme(sendTheme);

    } else {
      panel.webview.postMessage({
        type: 'init',
        id: fileUri.toString(),
        name: fileName,
        text: fileText
      });
    }
  }

  // Manual command
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.openWindows', () => {
      manuallyClosed = false;
      const editor = vscode.window.activeTextEditor;
      if (editor) createMonacoWindow(editor.document.uri);
    })
  );

  // Auto-open
  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor && !panel) createMonacoWindow(editor.document.uri);
  });

  // Document opened
  vscode.workspace.onDidOpenTextDocument(doc => {
    createMonacoWindow(doc.uri);
  });

  // Document closed
  vscode.workspace.onDidCloseTextDocument(doc => {
    panel?.webview.postMessage({
      type: 'close',
      id: doc.uri.toString()
    });
  });

  // 🔥 VS CODE → MONACO SYNC 🔥
  vscode.workspace.onDidChangeTextDocument(e => {
    if (!panel) return;

    // Send update only if source is NOT monaco to avoid loop
    panel.webview.postMessage({
      type: 'update',
      id: e.document.uri.toString(),
      text: e.document.getText(),
      source: 'vscode'
    });
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
