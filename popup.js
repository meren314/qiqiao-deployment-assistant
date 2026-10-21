/* 七巧部署助手 | Copyright (c) 2026 meren314 | Source Available License: LICENSE.txt */

const REQUIRED_FILES = ["index.html", "index.css", "index.js", "server.js"];
const TARGETS = [
  { fileName: "index.html", treeTitle: "index.html" },
  { fileName: "index.css", treeTitle: "index.css" },
  { fileName: "index.js", treeTitle: "index.js" },
  { fileName: "server.js", treeTitle: "自定义函数" }
];

const state = {
  rootHandle: null,
  rootNeedsPermission: false,
  pages: [],
  selectedPage: null
};

const elements = {
  chooseDirectory: document.getElementById("chooseDirectory"),
  directoryName: document.getElementById("directoryName"),
  pageSelect: document.getElementById("pageSelect"),
  fileStatus: document.getElementById("fileStatus"),
  writeCurrent: document.getElementById("writeCurrent"),
  writeAll: document.getElementById("writeAll"),
  writeAllAndPublish: document.getElementById("writeAllAndPublish"),
  log: document.getElementById("log")
};

document.getElementById("versionLabel").textContent = "v" + chrome.runtime.getManifest().version;

function setLog(lines) {
  elements.log.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("qiqiao-deploy-helper", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("handles")) {
        request.result.createObjectStore("handles");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveDirectoryHandle(handle) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, "deployment-root");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadDirectoryHandle() {
  const db = await openDatabase();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readonly");
    const request = tx.objectStore("handles").get("deployment-root");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
}

async function hasReadPermission(handle, requestPermission) {
  if (!handle) {
    return false;
  }
  const options = { mode: "read" };
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }
  if (requestPermission && (await handle.requestPermission(options)) === "granted") {
    return true;
  }
  return false;
}

async function inspectPageDirectory(directoryHandle) {
  const files = {};
  for (const fileName of REQUIRED_FILES) {
    try {
      const fileHandle = await directoryHandle.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      files[fileName] = {
        exists: true,
        size: file.size,
        modified: file.lastModified,
        handle: fileHandle
      };
    } catch (error) {
      files[fileName] = { exists: false, error: error.message };
    }
  }
  return {
    name: directoryHandle.name,
    handle: directoryHandle,
    files,
    complete: REQUIRED_FILES.every((fileName) => files[fileName].exists)
  };
}

async function scanRoot(rootHandle) {
  const directPage = await inspectPageDirectory(rootHandle);
  if (directPage.complete) {
    return [directPage];
  }

  const pages = [];
  for await (const entry of rootHandle.values()) {
    if (entry.kind !== "directory") {
      continue;
    }
    const page = await inspectPageDirectory(entry);
    if (page.complete) {
      pages.push(page);
    }
  }
  pages.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return pages;
}

function formatBytes(size) {
  if (size < 1024) {
    return size + " B";
  }
  return (size / 1024).toFixed(1) + " KB";
}

function renderSelectedPage() {
  const selectedName = elements.pageSelect.value;
  state.selectedPage = state.pages.find((page) => page.name === selectedName) || null;
  elements.fileStatus.textContent = "";

  if (!state.selectedPage) {
    elements.writeCurrent.disabled = true;
    elements.writeAll.disabled = true;
    elements.writeAllAndPublish.disabled = true;
    return;
  }

  for (const fileName of REQUIRED_FILES) {
    const info = state.selectedPage.files[fileName];
    const row = document.createElement("div");
    row.className = info.exists ? "file-ok" : "file-error";
    row.textContent = info.exists
      ? fileName + "：" + formatBytes(info.size)
      : fileName + "：缺失";
    elements.fileStatus.appendChild(row);
  }
  elements.writeCurrent.disabled = false;
  elements.writeAll.disabled = false;
  elements.writeAllAndPublish.disabled = false;
  chrome.storage.local.set({ selectedPageName: state.selectedPage.name });
}

async function renderPages() {
  elements.directoryName.textContent = state.rootHandle
    ? "已选择：" + state.rootHandle.name
    : "尚未选择目录";
  elements.pageSelect.textContent = "";

  if (!state.pages.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "未发现包含四个标准文件的页面目录";
    elements.pageSelect.appendChild(option);
    elements.pageSelect.disabled = true;
    renderSelectedPage();
    return;
  }

  for (const page of state.pages) {
    const option = document.createElement("option");
    option.value = page.name;
    option.textContent = page.name;
    elements.pageSelect.appendChild(option);
  }
  elements.pageSelect.disabled = false;
  const saved = await chrome.storage.local.get("selectedPageName");
  if (saved.selectedPageName && state.pages.some((page) => page.name === saved.selectedPageName)) {
    elements.pageSelect.value = saved.selectedPageName;
  }
  renderSelectedPage();
}

async function useDirectoryHandle(handle, persist) {
  state.rootHandle = handle;
  state.rootNeedsPermission = false;
  elements.directoryName.textContent = "正在扫描：" + handle.name;
  state.pages = await scanRoot(handle);
  if (persist) {
    await saveDirectoryHandle(handle);
  }
  await renderPages();
  elements.chooseDirectory.textContent = "更换部署目录";
  setLog("已恢复目录和页面选择。\n已识别 " + state.pages.length + " 个完整页面目录，可直接执行写入。");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].id) {
    throw new Error("没有找到当前浏览器标签页。");
  }
  if (!/^https?:/i.test(tabs[0].url || "")) {
    throw new Error("请在道一云的 HTTP 或 HTTPS 页面中使用插件。");
  }
  return tabs[0];
}

async function runInPage(action, payload) {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: qiqiaoPageBridge,
    args: [action, payload || null]
  });
  if (!results.length) {
    throw new Error("无法访问当前页面。");
  }
  const result = results[0].result;
  if (!result || !result.ok) {
    throw new Error(result && result.error ? result.error : "平台页面操作失败。");
  }
  return result;
}

async function readSelectedFiles() {
  if (!state.selectedPage) {
    throw new Error("请先选择页面文件夹。");
  }
  const output = [];
  for (const target of TARGETS) {
    const info = state.selectedPage.files[target.fileName];
    const file = await info.handle.getFile();
    output.push({
      fileName: target.fileName,
      treeTitle: target.treeTitle,
      content: await file.text(),
      modified: file.lastModified
    });
  }
  return output;
}

async function writeAllFiles(publishAfterWrite) {
  elements.writeAll.disabled = true;
  elements.writeAllAndPublish.disabled = true;
  elements.writeCurrent.disabled = true;
  setLog("正在读取本地文件……");
  try {
    const files = await readSelectedFiles();
    setLog("正在依次写入四个编辑器，请勿切换页面……");
    const action = publishAfterWrite ? "writeAllAndPublish" : "writeAll";
    const result = await runInPage(action, { pageName: state.selectedPage.name, files });
    setLog(result.lines);
  } catch (error) {
    setLog("写入失败：" + error.message);
  } finally {
    elements.writeAll.disabled = false;
    elements.writeAllAndPublish.disabled = false;
    elements.writeCurrent.disabled = false;
  }
}

async function writeCurrentFile() {
  elements.writeAll.disabled = true;
  elements.writeAllAndPublish.disabled = true;
  elements.writeCurrent.disabled = true;
  setLog("正在识别当前平台文件……");
  try {
    const files = await readSelectedFiles();
    const result = await runInPage("writeCurrent", { pageName: state.selectedPage.name, files });
    setLog(result.lines);
  } catch (error) {
    setLog("写入失败：" + error.message);
  } finally {
    elements.writeAll.disabled = false;
    elements.writeAllAndPublish.disabled = false;
    elements.writeCurrent.disabled = false;
  }
}

async function qiqiaoPageBridge(action, payload) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function findTreeLabels() {
    return Array.from(document.querySelectorAll(".tree-node-name, .el-tree-node__label[title]"));
  }

  function getCurrentTreeTitle() {
    const current = document.querySelector(".el-tree-node.is-current .tree-node-name, .el-tree-node.is-current .el-tree-node__label[title]");
    return current ? (current.getAttribute("title") || current.textContent || "").trim() : "";
  }

  function findTreeLabel(title) {
    return findTreeLabels().find((element) => {
      const value = (element.getAttribute("title") || element.textContent || "").trim();
      return value === title;
    }) || null;
  }

  function editorTabTitle(tab) {
    if (!tab) {
      return "";
    }
    const label = tab.querySelector("span") || tab;
    return (label.textContent || "").trim();
  }

  function findEditorTab(title) {
    return Array.from(document.querySelectorAll(".ace_tabs > div")).find((tab) => {
      return editorTabTitle(tab) === title;
    }) || null;
  }

  function getActiveEditorTabTitle() {
    return editorTabTitle(document.querySelector(".ace_tabs > div.cur"));
  }

  function fireMouseClick(element) {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  async function activateTreeNode(title) {
    const label = findTreeLabel(title);
    if (!label) {
      throw new Error("未找到平台文件节点：" + title);
    }
    const clickable = label.closest(".el-tree-node__content") || label;
    fireMouseClick(clickable);

    const deadline = Date.now() + 5000;
    const tabFallbackAt = Date.now() + 800;
    let tabFallbackClicked = false;
    let editorTab = null;
    let stableValue = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
      editorTab = findEditorTab(title);
      if (!tabFallbackClicked && Date.now() >= tabFallbackAt && getActiveEditorTabTitle() !== title) {
        if (editorTab) {
          const tabClickable = editorTab.querySelector("span") || editorTab;
          fireMouseClick(tabClickable);
        }
        tabFallbackClicked = true;
        stableValue = null;
        stableSince = 0;
      }
      if (editorTab && getActiveEditorTabTitle() === title) {
        const adapter = getEditorAdapter();
        if (adapter) {
          const currentValue = adapter.getValue();
          if (currentValue === stableValue) {
            if (stableSince && Date.now() - stableSince >= 500) {
              return;
            }
          } else {
            stableValue = currentValue;
            stableSince = Date.now();
          }
        }
      } else {
        stableValue = null;
        stableSince = 0;
      }
      await sleep(100);
    }
    throw new Error("平台编辑标签未切换到目标文件：" + title + "，已停止写入。");
  }

  function getEditorAdapter() {
    try {
      if (window.monaco && window.monaco.editor) {
        if (typeof window.monaco.editor.getEditors === "function") {
          const editors = window.monaco.editor.getEditors();
          const editor = editors.find((item) => {
            const node = typeof item.getDomNode === "function" ? item.getDomNode() : null;
            return node && isVisible(node);
          }) || editors[0];
          if (editor && typeof editor.setValue === "function") {
            return {
              type: "Monaco",
              getValue: () => editor.getValue(),
              setValue: (value) => editor.setValue(value),
              focus: () => editor.focus()
            };
          }
        }
        if (typeof window.monaco.editor.getModels === "function") {
          const models = window.monaco.editor.getModels();
          if (models.length === 1) {
            return {
              type: "Monaco model",
              getValue: () => models[0].getValue(),
              setValue: (value) => models[0].setValue(value),
              focus: () => {
                const textarea = document.querySelector(".monaco-editor textarea");
                if (textarea) {
                  textarea.focus();
                }
              }
            };
          }
        }
      }
    } catch (error) {
      console.warn("七巧部署助手：Monaco 检测失败", error);
    }

    const aceElements = Array.from(document.querySelectorAll(".ace_editor")).filter(isVisible);
    if (aceElements.length && window.ace && typeof window.ace.edit === "function") {
      const editor = window.ace.edit(aceElements[0]);
      return {
        type: "Ace",
        getValue: () => editor.getValue(),
        setValue: (value) => editor.setValue(value, -1),
        focus: () => editor.focus()
      };
    }

    const codeMirrorElements = Array.from(document.querySelectorAll(".CodeMirror")).filter(isVisible);
    if (codeMirrorElements.length && codeMirrorElements[0].CodeMirror) {
      const editor = codeMirrorElements[0].CodeMirror;
      return {
        type: "CodeMirror 5",
        getValue: () => editor.getValue(),
        setValue: (value) => editor.setValue(value),
        focus: () => editor.focus()
      };
    }

    const textareas = Array.from(document.querySelectorAll("textarea")).filter(isVisible);
    if (textareas.length) {
      const textarea = textareas.sort((a, b) => {
        const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return areaB - areaA;
      })[0];
      return {
        type: "Textarea",
        getValue: () => textarea.value,
        setValue: (value) => {
          const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
          descriptor.set.call(textarea, value);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.dispatchEvent(new Event("change", { bubbles: true }));
        },
        focus: () => textarea.focus()
      };
    }

    return null;
  }

  async function waitForEditor() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const adapter = getEditorAdapter();
      if (adapter) {
        return adapter;
      }
      await sleep(100);
    }
    throw new Error("未识别右侧代码编辑器，请补充编辑器 DOM 信息。");
  }

  function saveBackup(pageName, treeTitle, value) {
    const key = "qiqiaoDeployBackup:" + new Date().toISOString() + ":" + pageName + ":" + treeTitle;
    try {
      sessionStorage.setItem(key, value);
      return key;
    } catch (error) {
      return "备份失败：" + error.message;
    }
  }

  function visibleSaveNotices() {
    const selector = ".el-message, .el-notification, [role='alert'], .ant-message-notice, .ivu-message-notice";
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .map((element) => ({
        element,
        text: (element.textContent || "").replace(/\s+/g, "").trim()
      }))
      .filter((notice) => /保存.*成功|保存完成|更新成功/.test(notice.text));
  }

  function createSaveKeyEvent(type) {
    const event = new KeyboardEvent(type, {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      view: window
    });
    try {
      Object.defineProperty(event, "keyCode", { get: () => 83 });
      Object.defineProperty(event, "which", { get: () => 83 });
    } catch (ignore) {
    }
    return event;
  }

  async function saveCurrentEditor(treeTitle) {
    const previousNotices = visibleSaveNotices();
    const previousElements = previousNotices.map((notice) => notice.element);
    const target = document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : document;
    target.dispatchEvent(createSaveKeyEvent("keydown"));
    target.dispatchEvent(createSaveKeyEvent("keyup"));

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const notices = visibleSaveNotices();
      const freshNotice = notices.find((notice) => previousElements.indexOf(notice.element) === -1);
      if (freshNotice) {
        return freshNotice.text;
      }
      await sleep(150);
    }
    throw new Error(treeTitle + " 已写入编辑器，但未检测到平台保存成功反馈，已停止后续操作且不会发布。");
  }

  async function writeOne(file, pageName, activate) {
    if (activate) {
      await activateTreeNode(file.treeTitle);
    }
    if (getActiveEditorTabTitle() !== file.treeTitle) {
      throw new Error("当前活动编辑标签是“" + (getActiveEditorTabTitle() || "未知") + "”，目标是“" + file.treeTitle + "”，已停止写入。");
    }
    const adapter = await waitForEditor();
    const previousValue = adapter.getValue();
    const backupKey = saveBackup(pageName, file.treeTitle, previousValue);
    adapter.setValue(file.content);
    await sleep(150);
    if (getActiveEditorTabTitle() !== file.treeTitle) {
      throw new Error("写入期间活动标签发生变化，目标文件“" + file.treeTitle + "”未继续保存。");
    }
    const actualValue = adapter.getValue();
    if (actualValue !== file.content) {
      throw new Error(file.treeTitle + " 写入后回读不一致，已停止后续操作。");
    }
    if (adapter.focus) {
      adapter.focus();
    }
    const saveMessage = await saveCurrentEditor(file.treeTitle);
    return {
      treeTitle: file.treeTitle,
      fileName: file.fileName,
      editorType: adapter.type,
      length: actualValue.length,
      saveMessage,
      backupKey
    };
  }

  try {
    const labels = findTreeLabels();
    const foundTargets = ["index.html", "index.css", "index.js", "自定义函数"].filter((title) => !!findTreeLabel(title));

    if (!payload || !payload.files || !payload.pageName) {
      throw new Error("插件传入的数据不完整。");
    }
    if (foundTargets.length < 4) {
      throw new Error("左侧文件树不完整，只识别到：" + (foundTargets.join("、") || "无"));
    }

    if (action === "writeAll" || action === "writeAllAndPublish") {
      const lines = [];
      let releaseButton = null;
      if (action === "writeAllAndPublish") {
        releaseButton = document.querySelector('.menu_box a[title="发布"].icon_release, a.icon_release[title="发布"]');
        if (!releaseButton || !isVisible(releaseButton)) {
          throw new Error("未找到可用的发布按钮，已在写入前停止。");
        }
      }
      for (const file of payload.files) {
        const result = await writeOne(file, payload.pageName, true);
        lines.push("已保存：" + result.fileName + " → " + result.treeTitle + "（" + result.editorType + "，" + result.length + " 字符）");
      }
      if (action === "writeAllAndPublish") {
        releaseButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        releaseButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        releaseButton.click();
        lines.push("四个文件均已写入并确认保存成功，已点击平台发布按钮。");
      } else {
        lines.push("四个文件均已写入并确认保存成功。尚未点击发布。");
      }
      return { ok: true, lines };
    }

    if (action === "writeCurrent") {
      const currentTitle = getActiveEditorTabTitle() || getCurrentTreeTitle();
      const file = payload.files.find((item) => item.treeTitle === currentTitle);
      if (!file) {
        throw new Error("当前平台节点不是四个目标文件之一：" + (currentTitle || "未知"));
      }
      const result = await writeOne(file, payload.pageName, false);
      return {
        ok: true,
        lines: [
          "已保存：" + result.fileName + " → " + result.treeTitle,
          "编辑器：" + result.editorType,
          "字符数：" + result.length,
          "写入后回读一致，并已确认平台保存成功。"
        ]
      };
    }

    throw new Error("未知操作：" + action);
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

elements.chooseDirectory.addEventListener("click", async () => {
  try {
    if (state.rootHandle && state.rootNeedsPermission && await hasReadPermission(state.rootHandle, true)) {
      await useDirectoryHandle(state.rootHandle, false);
      return;
    }
    const handle = await window.showDirectoryPicker({ mode: "read" });
    await useDirectoryHandle(handle, true);
  } catch (error) {
    if (error.name !== "AbortError") {
      setLog("目录读取失败：" + error.message);
    }
  }
});

elements.pageSelect.addEventListener("change", renderSelectedPage);
elements.writeAll.addEventListener("click", () => writeAllFiles(false));
elements.writeAllAndPublish.addEventListener("click", () => writeAllFiles(true));
elements.writeCurrent.addEventListener("click", writeCurrentFile);

(async () => {
  try {
    const handle = await loadDirectoryHandle();
    if (handle && await hasReadPermission(handle, false)) {
      await useDirectoryHandle(handle, false);
    } else if (handle) {
      state.rootHandle = handle;
      state.rootNeedsPermission = true;
      elements.directoryName.textContent = "已记住：" + handle.name + "（需要恢复读取授权）";
      elements.chooseDirectory.textContent = "恢复上次目录";
      setLog("已记住上次目录和页面选择。\n点击“恢复上次目录”后即可继续使用。");
    }
  } catch (error) {
    setLog("恢复上次目录失败，请重新选择目录。\n" + error.message);
  }
})();
