const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

let panel = null;
let manuallyClosed = false;
let typingTimer = null;
let monacoMessageTimer = null;
let lastText = '';

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

      panel.webview.html = getWebviewHtml(context, panel.webview);

      vscode.workspace.textDocuments.forEach(doc => {
        panel.webview.postMessage({
          type: 'init',
          id: doc.uri.toString(),
          name: path.basename(doc.uri.fsPath || 'Untitled'),
          text: doc.getText()
        });
      });

      panel.webview.onDidReceiveMessage(message => {
        if (message.type === 'edit' && message.source === 'monaco') {
          const uri = vscode.Uri.parse(message.id);
          const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
          if (!doc) return;

          clearTimeout(monacoMessageTimer);

          monacoMessageTimer = setTimeout(() => {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length)
            );

            edit.replace(uri, fullRange, message.text);
            vscode.workspace.applyEdit(edit);
            lastText = message.text;
          }, 300);
        }
      });

      const sendTheme = () => panel?.webview.postMessage({ type: 'themeColors' });
      sendTheme();
      vscode.window.onDidChangeActiveColorTheme(sendTheme);

      vscode.window.showInformationMessage('Windows extension has been successfully loaded.');
    } else {
      panel.webview.postMessage({
        type: 'init',
        id: fileUri.toString(),
        name: fileName,
        text: fileText
      });
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.openWindows', () => {
      manuallyClosed = false;
      vscode.workspace.textDocuments.forEach(doc => createMonacoWindow(doc.uri));
    })
  );

  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor && !panel) createMonacoWindow(editor.document.uri);
  });

  vscode.workspace.onDidOpenTextDocument(doc => {
    createMonacoWindow(doc.uri);
  });

  vscode.workspace.onDidCloseTextDocument(doc => {
    panel?.webview.postMessage({
      type: 'close',
      id: doc.uri.toString()
    });
  });

  vscode.workspace.onDidChangeTextDocument(e => {
    if (!panel) return;

    clearTimeout(typingTimer);

    typingTimer = setTimeout(() => {
      const text = e.document.getText();
      if (text !== lastText) {
        panel.webview.postMessage({
          type: 'update',
          id: e.document.uri.toString(),
          text: text,
          source: 'vscode'
        });
        lastText = text;
      }
    }, 300);
  });

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading Monaco Editor...",
      cancellable: false
    },
    async (progress) => {
      progress.report({ increment: 0 });
      vscode.workspace.textDocuments.forEach(doc => createMonacoWindow(doc.uri));
      progress.report({ increment: 100 });
    }
  );
}


function deactivate() {}

function getWebviewHtml(context, webview) {
  const monacoUri = vscode.Uri.joinPath(context.extensionUri, 'src', 'vs');
  const loaderJsUri = webview.asWebviewUri(vscode.Uri.joinPath(monacoUri, 'loader.js'));
  const vsUri = webview.asWebviewUri(monacoUri);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Windows</title>
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden;
background: var(--vscode-editor-background, #1e1e1e);
color: var(--vscode-editor-foreground, #d4d4d4); font-family: sans-serif;
}
#workspace { position: absolute; left:0; top:0; width:5000px; height:5000px; transform-origin:0 0; }
.window { position: absolute; width:420px; height:300px; background: var(--vscode-editor-background, #252526);
border: 1px solid #333; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6); }
.titlebar { height: 28px; background: #333; color: #fff; padding: 4px 8px; cursor: move; user-select: none; font-size: 13px; }
.editor { width: 100%; height: calc(100% - 28px); }
.resize-handle { position: absolute; width: 20px; height: 20px; top: 0; right: 0; cursor: ne-resize; z-index: 10; background: #888; clip-path: polygon(100% 0, 0 0, 100% 100%); }
</style>
</head>
<body>
<div id="workspace"></div>
<script src="${loaderJsUri}"></script>
<script>
const vscode = acquireVsCodeApi();
let windowCount = 0, zIndex = 1, panX = 0, panY = 0, zoom = 1;
const MIN_ZOOM = 0.3, MAX_ZOOM = 2.5, ZOOM_STEP = 0.1, MIN_WIDTH = 100, MIN_HEIGHT = 50;
const workspace = document.getElementById('workspace');
const editors = {};

function updateTransform() { workspace.style.transform = \`translate(\${panX}px,\${panY}px) scale(\${zoom})\`; }

function zoomAt(cx, cy, nextZoom) {
  nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  const oldZoom = zoom, offsetX = (cx - panX) / oldZoom, offsetY = (cy - panY) / oldZoom;
  zoom = nextZoom;
  panX = cx - offsetX * zoom;
  panY = cy - offsetY * zoom;
  updateTransform();
}

require.config({ paths: { vs: '${vsUri}' } });

require(['vs/editor/editor.main'], () => {
function makeDraggable(win, title) {
  let dragging = false, startX, startY, startLeft, startTop;
  title.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startY = e.clientY;
    startLeft = parseFloat(win.style.left); startTop = parseFloat(win.style.top);
    win.style.zIndex = ++zIndex; e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = (e.clientX - startX) / zoom, dy = (e.clientY - startY) / zoom;
    win.style.left = startLeft + dx + 'px';
    win.style.top = startTop + dy + 'px';
  });
  document.addEventListener('mouseup', () => dragging = false);
}

function getVSCodeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    background: s.getPropertyValue('--vscode-editor-background')?.trim() || '#1e1e1e',
    foreground: s.getPropertyValue('--vscode-editor-foreground')?.trim() || '#d4d4d4',
    cursor: s.getPropertyValue('--vscode-editorCursor-foreground')?.trim() || '#aeafad',
    selection: s.getPropertyValue('--vscode-editor-selectionBackground')?.trim() || '#264f78',
    lineHighlight: s.getPropertyValue('--vscode-editor-lineHighlightBackground')?.trim() || '#2a2d2e'
  };
}

function applyVSCodeTheme() {
  const c = getVSCodeColors();
  monaco.editor.defineTheme('vscode-current', {
    base: c.background === '#ffffff' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': c.background,
      'editor.foreground': c.foreground,
      'editorCursor.foreground': c.cursor,
      'editor.selectionBackground': c.selection,
      'editor.lineHighlightBackground': c.lineHighlight
    }
  });
  monaco.editor.setTheme('vscode-current');
}

function getLanguageForFile(fileName) {
  const parts = fileName.split('.');
  if (parts.length < 2) return 'plaintext';
  const ext = '.' + parts.pop().toLowerCase();
  const langs = monaco.languages.getLanguages();
  for (const lang of langs) {
    if (lang.extensions && lang.extensions.includes(ext)) return lang.id;
  }
  return 'plaintext';
}

function createWindow(fileId, fileName, initialText) {
  if (editors[fileId]) return;

  const win = document.createElement('div');
  win.className = 'window';
  win.style.left = 300 + windowCount * 40 + 'px';
  win.style.top = 300 + windowCount * 40 + 'px';
  win.style.zIndex = ++zIndex;
  windowCount++;

  const title = document.createElement('div');
  title.className = 'titlebar';
  title.textContent = fileName;

  const editorEl = document.createElement('div');
  editorEl.className = 'editor';

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle';

  win.appendChild(title);
  win.appendChild(editorEl);
  win.appendChild(resizeHandle);
  workspace.appendChild(win);

  const editor = monaco.editor.create(editorEl, {
    value: initialText,
    language: getLanguageForFile(fileName),
    automaticLayout: true
  });

  applyVSCodeTheme();

  editor.onDidChangeModelContent(() => {
    vscode.postMessage({ type: 'edit', id: fileId, text: editor.getValue(), source: 'monaco' });
  });

  editors[fileId] = { editor, win };
  makeDraggable(win, title);

  resizeHandle.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = win.offsetWidth, startH = win.offsetHeight;
    const startTop = parseFloat(win.style.top);
    function move(ev) {
      const newW = Math.max(MIN_WIDTH, startW + (ev.clientX - startX) / zoom);
      const newH = Math.max(MIN_HEIGHT, startH - (ev.clientY - startY) / zoom);
      win.style.width = newW + 'px';
      win.style.height = newH + 'px';
      win.style.top = startTop + (startH - newH) + 'px';
    }
    function end() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', end);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', end);
  });

  win.addEventListener('mousedown', () => win.style.zIndex = ++zIndex);
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'init') createWindow(msg.id, msg.name, msg.text);
  if (msg.type === 'themeColors') applyVSCodeTheme();
  if (msg.type === 'close' && editors[msg.id]) {
    editors[msg.id].editor.dispose();
    editors[msg.id].win.remove();
    delete editors[msg.id];
  }
  if (msg.type === 'update' && msg.source === 'vscode') {
    const ed = editors[msg.id];
    if (!ed) return;
    const model = ed.editor.getModel();
    if (model.getValue() !== msg.text) {
      ed.editor.pushUndoStop();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: msg.text }], () => null);
      ed.editor.pushUndoStop();
    }
  }
});

let isPanning = false, panStartX, panStartY, panStartPanX, panStartPanY;
document.body.addEventListener('mousedown', e => {
  if (e.button !== 1) return;
  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panStartPanX = panX;
  panStartPanY = panY;
});
document.body.addEventListener('mousemove', e => {
  if (!isPanning) return;
  panX = panStartPanX + (e.clientX - panStartX);
  panY = panStartPanY + (e.clientY - panStartY);
  updateTransform();
});
document.body.addEventListener('mouseup', e => {
  if (e.button === 1) isPanning = false;
});
document.body.addEventListener('wheel', e => {
  if (e.target.closest('.window')) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, zoom + (e.deltaY < 0 ? 1 : -1) * ZOOM_STEP);
}, { passive: false });

updateTransform();
});
</script>
</body>
</html>
`;
}

module.exports = { activate, deactivate };
