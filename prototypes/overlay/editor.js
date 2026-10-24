const editor = document.getElementById("editor");

window.editorBridge.onQuery(() => {
  window.editorBridge.report({
    activeElementId: document.activeElement?.id ?? null,
    hasFocus: document.hasFocus(),
    selectionStart: editor.selectionStart,
    valueLength: editor.value.length,
  });
});
