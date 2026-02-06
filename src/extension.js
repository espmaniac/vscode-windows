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

        if (message.type === 'requestCompletions') {
          (async () => {
            try {
              const uri = vscode.Uri.parse(message.id);
              const pos = new vscode.Position(Math.max(0, message.position.lineNumber - 1), Math.max(0, message.position.column - 1));
              const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, pos, message.triggerCharacter);
              const items = (list && list.items) ? list.items : (Array.isArray(list) ? list : []);
              panel.webview.postMessage({
                type: 'completions',
                id: message.id,
                items: items
              });
            } catch (err) {
              console.error('Error requesting completions:', err);
              panel.webview.postMessage({
                type: 'completions',
                id: message.id,
                items: []
              });
            }
          })();
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

const KEEP_TEMP_PROVIDER_MS = 10000;
const pendingCompletions = {};
const registeredProviders = {};
const suppressOnType = {};
const activeTempProvider = {};
const completionPressCount = {};
const lastShownCompletions = {};
let activeFileId = null;

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

function ensureProviderForLanguage(lang) {
  if (registeredProviders[lang]) return;
  registeredProviders[lang] = true;

  monaco.languages.registerCompletionItemProvider(lang, {
    provideCompletionItems: function(model, position, context) {
      const fid = model.uri.toString();

      if (activeTempProvider[fid]) {
        return { suggestions: [] };
      }

      try {
        const TriggerKind = monaco.languages.CompletionTriggerKind;
        if (context && context.triggerKind === TriggerKind.TriggerCharacter && suppressOnType[fid]) {
          delete suppressOnType[fid];
          return { suggestions: [] };
        }
      } catch (e) {}

      const items = pendingCompletions[fid];
      if (!items || items.length === 0) return { suggestions: [] };

      delete pendingCompletions[fid];

      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

      const suggestions = items.map(it => ({
        label: it.label,
        kind: (typeof it.kind === 'number') ? it.kind : monaco.languages.CompletionItemKind.Text,
        documentation: it.documentation || it.detail || '',
        insertText: (typeof it.insertText === 'string') ? it.insertText : (it.text || it.label || ''),
        range: range,
        sortText: it.sortText,
        filterText: it.filterText
      }));

      return { suggestions };
    }
  });
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
  editorEl.tabIndex = 0;

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle';

  win.appendChild(title);
  win.appendChild(editorEl);
  win.appendChild(resizeHandle);
  workspace.appendChild(win);

  const language = getLanguageForFile(fileName);

  try {
    const existingModel = monaco.editor.getModel(monaco.Uri.parse(fileId));
    if (existingModel) {
      try { existingModel.dispose(); } catch (e) { console.warn('Failed to dispose existing model', e); }
    }
  } catch (e) {}

  const model = monaco.editor.createModel(initialText, language, monaco.Uri.parse(fileId));
  const editor = monaco.editor.create(editorEl, {
    model: model,
    automaticLayout: true
  });

  applyVSCodeTheme();
  ensureProviderForLanguage(language);

  editor.onDidChangeModelContent(() => {
    vscode.postMessage({ type: 'edit', id: fileId, text: editor.getValue(), source: 'monaco' });
  });

  try {
    editor.onDidFocusEditorWidget(() => {
      activeFileId = fileId;
      editors[fileId] && (editors[fileId].win.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.8)');
    });
    editor.onDidBlurEditorWidget(() => {
      if (activeFileId === fileId) activeFileId = null;
      editors[fileId] && (editors[fileId].win.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.6)');
    });
  } catch (e) {
    editorEl.addEventListener('focusin', () => { activeFileId = fileId; editors[fileId] && (editors[fileId].win.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.8)'); });
    editorEl.addEventListener('focusout', () => { if (activeFileId === fileId) activeFileId = null; editors[fileId] && (editors[fileId].win.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.6)'); });
  }

  editors[fileId] = { editor, win, model, language };
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

document.addEventListener('keydown', e => {
  const isCtrlSpace = (e.ctrlKey || e.metaKey) && (e.code === 'Space' || e.key === ' ');
  if (!isCtrlSpace) return;

  e.preventDefault();

  if (!activeFileId) return;
  const edWrap = editors[activeFileId];
  if (!edWrap) return;
  const pos = edWrap.editor.getPosition();
  if (!pos) return;

  completionPressCount[activeFileId] = (completionPressCount[activeFileId] || 0) + 1;
  const pressCount = completionPressCount[activeFileId];

  if (pressCount % 2 === 1) {
    vscode.postMessage({
      type: 'requestCompletions',
      id: activeFileId,
      position: pos
    });
  } else {
    edWrap.editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
  }
}, true);

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'init') createWindow(msg.id, msg.name, msg.text);
  if (msg.type === 'themeColors') applyVSCodeTheme();
  if (msg.type === 'close' && editors[msg.id]) {
    try {
      const ed = editors[msg.id];
      try { ed.editor.dispose(); } catch (e) { console.warn('Failed to dispose editor', e); }
      try { if (ed.model) ed.model.dispose(); } catch (e) { console.warn('Failed to dispose model', e); }
      ed.win.remove();
    } catch (err) {
      console.error('Error while closing editor for', msg.id, err);
    } finally {
      delete editors[msg.id];
      delete completionPressCount[msg.id];
      delete lastShownCompletions[msg.id];
      if (activeFileId === msg.id) activeFileId = null;
    }
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

  if (msg.type === 'completions') {
    const newItems = (msg.items || []).map(i => {
      return {
        label: i.label,
        insertText: (i.insertText || (i.textEdit && i.textEdit.newText) || i.text) || i.label,
        kind: i.kind,
        documentation: (i.documentation && (typeof i.documentation === 'string' ? i.documentation : i.documentation.value)) || i.detail || '',
        sortText: i.sortText,
        filterText: i.filterText
      };
    });

    const edWrap = editors[msg.id];
    if (edWrap) {
      const fid = msg.id;
      const pressCount = completionPressCount[fid] || 1;

      let itemsToShow = newItems;

      if (pressCount >= 3) {
        const lastItems = lastShownCompletions[fid] || [];
        const lastLabels = new Set(lastItems.map(i => i.label));
        itemsToShow = newItems.filter(item => !lastLabels.has(item.label));
      }

      lastShownCompletions[fid] = newItems;

      if (itemsToShow.length > 0 || pressCount === 1) {
        activeTempProvider[fid] = true;

        let tempProvider = null;
        try {
          tempProvider = monaco.languages.registerCompletionItemProvider(edWrap.language, {
            provideCompletionItems: function(model, position) {
              try {
                if (model.uri.toString() !== fid) return { suggestions: [] };

                const word = model.getWordUntilPosition(position);
                const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
                const suggestions = itemsToShow.map(it => ({
                  label: it.label,
                  kind: (typeof it.kind === 'number') ? it.kind : monaco.languages.CompletionItemKind.Text,
                  documentation: it.documentation || '',
                  insertText: (typeof it.insertText === 'string') ? it.insertText : it.label,
                  range: range,
                  sortText: it.sortText,
                  filterText: it.filterText
                }));

                suppressOnType[fid] = true;
                setTimeout(() => { if (suppressOnType[fid]) delete suppressOnType[fid]; }, 900);

                return { suggestions };
              } catch (err) {
                return { suggestions: [] };
              }
            }
          });
        } catch (err) {
          console.error('Temp provider registration failed', err);
          delete activeTempProvider[fid];
        }

        edWrap.editor.trigger('keyboard', 'editor.action.triggerSuggest', {});

        setTimeout(() => {
          try { if (tempProvider) tempProvider.dispose(); } catch (e) {}
          delete activeTempProvider[fid];
        }, KEEP_TEMP_PROVIDER_MS);
      } else {
        edWrap.editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
      }
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
