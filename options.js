const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");

const fields = {
  collectorName: document.getElementById("collectorName"),
  authMode: document.getElementById("authMode"),
  personalBaseToken: document.getElementById("personalBaseToken"),
  appId: document.getElementById("appId"),
  appSecret: document.getElementById("appSecret"),
  appToken: document.getElementById("appToken"),
  tableId: document.getElementById("tableId"),
  baseUrl: document.getElementById("baseUrl"),
  autoCreateFields: document.getElementById("autoCreateFields"),
  upsertByCreatorId: document.getElementById("upsertByCreatorId"),
  transcriptionEnabled: document.getElementById("transcriptionEnabled"),
  aliyunApiKey: document.getElementById("aliyunApiKey"),
  monitorEnabled: document.getElementById("monitorEnabled"),
  targetConversation: document.getElementById("targetConversation"),
  selfSenderName: document.getElementById("selfSenderName"),
  openOnStartup: document.getElementById("openOnStartup"),
};
const monitorStatusNode = document.getElementById("monitorStatus");

loadSettings();
fields.authMode.addEventListener("change", updateAuthModeVisibility);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await Promise.all([
      sendMessage({ type: "douhot:saveSettings", payload: readSettings() }),
      sendMessage({ type: "douhot:saveMonitorSettings", payload: readMonitorSettings() }),
      sendMessage({ type: "douhot:saveTranscriptionSettings", payload: readTranscriptionSettings() }),
    ]);
    setStatus("收集人、飞书、监控与逐字稿设置已保存。");
    await refreshMonitorStatus();
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.getElementById("test").addEventListener("click", async () => {
  try {
    setStatus("正在测试连接...");
    await sendMessage({ type: "douhot:saveSettings", payload: readSettings() });
    const response = await sendMessage({ type: "douhot:testFeishu", payload: readSettings() });
    setStatus(`连接成功，目标表已有 ${response.data.fieldCount} 个字段。`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.getElementById("parseUrl").addEventListener("click", () => {
  const parsed = parseBaseUrl(fields.baseUrl.value);
  if (!parsed.appToken && !parsed.tableId) {
    setStatus("没有从 URL 里识别出 app_token 或 table_id。", true);
    return;
  }
  if (parsed.appToken) fields.appToken.value = parsed.appToken;
  if (parsed.tableId) fields.tableId.value = parsed.tableId;
  if (parsed.wikiToken && !parsed.appToken) {
    setStatus(`已填入 table_id。这个是 wiki 链接，wiki token ${parsed.wikiToken} 还需要解析成真实 base_token。`, true);
    return;
  }
  setStatus("已从 URL 填入。");
});

document.getElementById("openMonitor").addEventListener("click", async () => {
  try {
    await sendMessage({ type: "douhot:saveMonitorSettings", payload: readMonitorSettings() });
    await sendMessage({ type: "douhot:openMonitor" });
    setMonitorStatus("监控页已打开，正在建立历史基线。", false);
  } catch (error) {
    setMonitorStatus(error.message, true);
  }
});

document.getElementById("refreshMonitorStatus").addEventListener("click", refreshMonitorStatus);

async function loadSettings() {
  try {
    const response = await sendMessage({ type: "douhot:getSettings" });
    const settings = response.data || {};
    fields.collectorName.value = settings.collectorName || "";
    fields.authMode.value = settings.authMode || "personalBaseToken";
    fields.personalBaseToken.value = settings.personalBaseToken || "";
    fields.appId.value = settings.appId || "";
    fields.appSecret.value = settings.appSecret || "";
    fields.appToken.value = settings.appToken || "";
    fields.tableId.value = settings.tableId || "";
    fields.autoCreateFields.checked = settings.autoCreateFields !== false;
    fields.upsertByCreatorId.checked = settings.upsertByCreatorId !== false;
    updateAuthModeVisibility();
    const transcriptionResponse = await sendMessage({ type: "douhot:getTranscriptionSettings" });
    const transcription = transcriptionResponse.data || {};
    fields.transcriptionEnabled.checked = transcription.enabled === true;
    fields.aliyunApiKey.value = transcription.apiKey || "";
    const monitorResponse = await sendMessage({ type: "douhot:getMonitorSettings" });
    const monitor = monitorResponse.data || {};
    fields.monitorEnabled.checked = monitor.enabled === true;
    fields.targetConversation.value = monitor.targetConversation || "";
    fields.selfSenderName.value = monitor.selfSenderName || "";
    fields.openOnStartup.checked = monitor.openOnStartup === true;
    await refreshMonitorStatus();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function readTranscriptionSettings() {
  return {
    enabled: fields.transcriptionEnabled.checked,
    apiKey: fields.aliyunApiKey.value.trim(),
  };
}

function readMonitorSettings() {
  return {
    enabled: fields.monitorEnabled.checked,
    targetConversation: fields.targetConversation.value.trim(),
    selfSenderName: fields.selfSenderName.value.trim(),
    openOnStartup: fields.openOnStartup.checked,
  };
}

async function refreshMonitorStatus() {
  try {
    const response = await sendMessage({ type: "douhot:getMonitorStatus" });
    const status = response.data || {};
    const parts = [status.message || "等待监控启动"];
    if (status.lastSuccessAt) parts.push(`最近成功：${formatLocalTime(status.lastSuccessAt)}`);
    if (Number(status.pendingCount) > 0) parts.push(`待重试：${status.pendingCount} 条`);
    setMonitorStatus(parts.join("｜"), status.state === "error");
  } catch (error) {
    setMonitorStatus(error.message, true);
  }
}

function setMonitorStatus(message, isError = false) {
  monitorStatusNode.textContent = message;
  monitorStatusNode.classList.toggle("error", isError);
}

function formatLocalTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleString("zh-CN", { hour12: false });
}

function readSettings() {
  return {
    enabled: true,
    collectorName: fields.collectorName.value.trim(),
    authMode: fields.authMode.value,
    personalBaseToken: fields.personalBaseToken.value.trim(),
    appId: fields.appId.value.trim(),
    appSecret: fields.appSecret.value.trim(),
    appToken: fields.appToken.value.trim(),
    tableId: fields.tableId.value.trim(),
    autoCreateFields: fields.autoCreateFields.checked,
    upsertByCreatorId: fields.upsertByCreatorId.checked,
  };
}

function updateAuthModeVisibility() {
  const isOpenApi = fields.authMode.value === "openApi";
  document.getElementById("personal-token-section").hidden = isOpenApi;
  document.getElementById("open-api-section").hidden = !isOpenApi;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "操作失败"));
        return;
      }
      resolve(response);
    });
  });
}

function parseBaseUrl(input) {
  const source = String(input || "").trim();
  const result = { appToken: "", tableId: "", wikiToken: "" };
  if (!source) return result;
  try {
    const url = new URL(source);
    const baseMatch = url.pathname.match(/\/base\/([^/?#]+)/);
    if (baseMatch) result.appToken = decodeURIComponent(baseMatch[1]);
    const wikiMatch = url.pathname.match(/\/wiki\/([^/?#]+)/);
    if (wikiMatch) result.wikiToken = decodeURIComponent(wikiMatch[1]);
    result.tableId = url.searchParams.get("table") || url.searchParams.get("table_id") || "";
  } catch (error) {
    const baseMatch = source.match(/\/base\/([^/?#]+)/);
    if (baseMatch) result.appToken = decodeURIComponent(baseMatch[1]);
    const wikiMatch = source.match(/\/wiki\/([^/?#]+)/);
    if (wikiMatch) result.wikiToken = decodeURIComponent(wikiMatch[1]);
    const tableMatch = source.match(/[?&](?:table|table_id)=([^&#]+)/);
    if (tableMatch) result.tableId = decodeURIComponent(tableMatch[1]);
  }
  return result;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle("error", isError);
}
