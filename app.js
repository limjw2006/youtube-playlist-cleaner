"use strict";

// ⚠️ 배포 전 반드시 본인의 웹용 OAuth 클라이언트 ID로 교체하세요.
const CLIENT_ID = "여기에_발급받은_웹_클라이언트_ID.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/youtube.force-ssl";
const API_BASE = "https://www.googleapis.com/youtube/v3";

const UNAVAILABLE_TITLE_MARKERS = new Set([
  "Deleted video",
  "Private video",
  "삭제된 동영상",
  "비공개 동영상",
]);

const el = {
  account: document.getElementById("account"),
  viewSignedOut: document.getElementById("view-signedout"),
  btnConnect: document.getElementById("btn-connect"),
  signedOutError: document.getElementById("signedout-error"),

  viewPlaylists: document.getElementById("view-playlists"),
  btnRefresh: document.getElementById("btn-refresh"),
  playlistList: document.getElementById("playlist-list"),
  playlistsEmpty: document.getElementById("playlists-empty"),

  viewScanning: document.getElementById("view-scanning"),
  scanStatusText: document.getElementById("scan-status-text"),
  scanProgress: document.getElementById("scan-progress"),

  viewResults: document.getElementById("view-results"),
  resultsPlaylistTitle: document.getElementById("results-playlist-title"),
  resultsSummary: document.getElementById("results-summary"),
  resultsClean: document.getElementById("results-clean"),
  resultsList: document.getElementById("results-list"),
  resultsActions: document.getElementById("results-actions"),
  btnBack: document.getElementById("btn-back"),
  btnSelectAll: document.getElementById("btn-select-all"),
  btnExport: document.getElementById("btn-export"),
  btnDelete: document.getElementById("btn-delete"),

  footerError: document.getElementById("footer-error"),
};

let state = {
  token: null,
  currentPlaylist: null,
  unavailable: [],
};

let tokenClient = null;

// ---------------------------------------------------------------
// 화면 전환 유틸
// ---------------------------------------------------------------

function showView(name) {
  for (const v of [el.viewSignedOut, el.viewPlaylists, el.viewScanning, el.viewResults]) {
    v.classList.add("hidden");
  }
  ({
    signedout: el.viewSignedOut,
    playlists: el.viewPlaylists,
    scanning: el.viewScanning,
    results: el.viewResults,
  }[name]).classList.remove("hidden");
}

function showFooterError(message) {
  el.footerError.textContent = message;
  el.footerError.classList.remove("hidden");
}

function clearFooterError() {
  el.footerError.classList.add("hidden");
}

// ---------------------------------------------------------------
// 인증 (Google Identity Services)
// ---------------------------------------------------------------

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: "", // 요청마다 개별 콜백을 지정
  });
}

function requestAccessToken({ silent } = { silent: false }) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error("아직 초기화되지 않았습니다. 잠시 후 다시 시도해주세요."));
      return;
    }
    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      resolve(resp.access_token);
    };
    tokenClient.requestAccessToken({ prompt: silent ? "none" : "consent" });
  });
}

// ---------------------------------------------------------------
// API 호출 (401이면 재로그인 요청 후 1회 재시도)
// ---------------------------------------------------------------

async function apiFetch(url, options = {}) {
  const doFetch = async (token) =>
    fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });

  let res = await doFetch(state.token);

  if (res.status === 401) {
    state.token = await requestAccessToken({ silent: false });
    res = await doFetch(state.token);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API 오류 (${res.status}): ${body.slice(0, 200)}`);
  }

  if (options.method === "DELETE") return null;
  return res.json();
}

// ---------------------------------------------------------------
// 재생목록 목록
// ---------------------------------------------------------------

async function fetchMyPlaylists() {
  const playlists = [];
  let pageToken = "";
  do {
    const url = new URL(`${API_BASE}/playlists`);
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await apiFetch(url.toString());
    playlists.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return playlists;
}

function renderPlaylists(playlists) {
  el.playlistList.innerHTML = "";
  el.playlistsEmpty.classList.toggle("hidden", playlists.length > 0);

  for (const pl of playlists) {
    const thumb =
      pl.snippet.thumbnails?.medium?.url ||
      pl.snippet.thumbnails?.default?.url ||
      "";

    const li = document.createElement("li");
    li.className = "playlist-item";
    li.innerHTML = `
      <div class="pl-text">
        <span class="pl-title"></span>
        <span class="pl-count"></span>
      </div>
      <div class="pl-thumb-wrap">
        ${thumb ? `<img class="pl-thumb" src="${thumb}" alt="" loading="lazy" />` : `<div class="pl-thumb pl-thumb-empty"></div>`}
      </div>
    `;
    li.querySelector(".pl-title").textContent = pl.snippet.title;
    li.querySelector(".pl-count").textContent = `${pl.contentDetails.itemCount}개`;
    li.addEventListener("click", () => scanPlaylist(pl.id, pl.snippet.title));
    el.playlistList.appendChild(li);
  }
}

// ---------------------------------------------------------------
// 재생목록 항목 + 이용 불가 탐지
// ---------------------------------------------------------------

async function fetchPlaylistItems(playlistId, onProgress) {
  const items = [];
  let pageToken = "";
  do {
    const url = new URL(`${API_BASE}/playlistItems`);
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await apiFetch(url.toString());
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
    onProgress?.(items.length);
  } while (pageToken);
  return items;
}

async function fetchExistingVideoIds(videoIds) {
  const existing = new Set();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set("part", "status");
    url.searchParams.set("id", batch.join(","));
    const data = await apiFetch(url.toString());
    for (const item of data.items || []) existing.add(item.id);
  }
  return existing;
}

function detectUnavailable(items, existingIds) {
  const unavailable = [];
  for (const it of items) {
    const videoId = it.contentDetails.videoId;
    const title = it.snippet?.title || "";
    const position = it.snippet?.position;
    const playlistItemId = it.id;

    let reason = null;
    if (UNAVAILABLE_TITLE_MARKERS.has(title)) {
      reason = `제목이 "${title}"(으)로 표시됨`;
    } else if (!existingIds.has(videoId)) {
      reason = "완전히 삭제된 영상";
    }

    if (reason) {
      unavailable.push({ playlistItemId, videoId, title, position, reason });
    }
  }
  return unavailable;
}

async function scanPlaylist(playlistId, playlistTitle) {
  state.currentPlaylist = { id: playlistId, title: playlistTitle };
  clearFooterError();
  showView("scanning");
  el.scanStatusText.textContent = "영상 목록 불러오는 중…";
  el.scanProgress.textContent = "";

  try {
    const items = await fetchPlaylistItems(playlistId, (count) => {
      el.scanProgress.textContent = `${count}개 확인함`;
    });

    el.scanStatusText.textContent = "삭제/비공개 여부 확인 중…";
    const videoIds = items.map((it) => it.contentDetails.videoId);
    const existingIds = await fetchExistingVideoIds(videoIds);

    const unavailable = detectUnavailable(items, existingIds);
    state.unavailable = unavailable;

    renderResults(playlistTitle, items.length, unavailable);
    showView("results");
  } catch (err) {
    showView("playlists");
    showFooterError(err.message);
  }
}

// ---------------------------------------------------------------
// 결과 화면
// ---------------------------------------------------------------

function renderResults(playlistTitle, totalCount, unavailable) {
  el.resultsPlaylistTitle.textContent = playlistTitle;
  el.resultsSummary.textContent = Number.isNaN(totalCount)
    ? `이용 불가 영상 ${unavailable.length}개가 남아있습니다.`
    : `전체 ${totalCount}개 중 이용 불가 영상 ${unavailable.length}개를 찾았습니다.`;

  el.resultsClean.classList.toggle("hidden", unavailable.length !== 0);
  el.resultsList.classList.toggle("hidden", unavailable.length === 0);
  el.resultsActions.classList.toggle("hidden", unavailable.length === 0);

  el.resultsList.innerHTML = "";
  for (const item of unavailable) {
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML = `
      <input type="checkbox" checked data-item-id="${item.playlistItemId}" />
      <div class="result-body">
        <div class="result-title"></div>
        <div class="result-reason"></div>
      </div>
    `;
    li.querySelector(".result-title").textContent =
      item.title && item.title.trim() ? item.title : `(제목 없음) ${item.videoId}`;
    li.querySelector(".result-reason").textContent = item.reason;
    el.resultsList.appendChild(li);
  }
}

function getSelectedItemIds() {
  return Array.from(
    el.resultsList.querySelectorAll('input[type="checkbox"]:checked')
  ).map((cb) => cb.dataset.itemId);
}

async function deleteSelected() {
  const selectedIds = getSelectedItemIds();
  if (selectedIds.length === 0) return;

  const confirmed = confirm(
    `선택한 ${selectedIds.length}개 영상을 재생목록에서 삭제할까요? 되돌릴 수 없습니다.`
  );
  if (!confirmed) return;

  el.btnDelete.disabled = true;
  clearFooterError();

  const failed = [];
  for (const itemId of selectedIds) {
    try {
      const url = new URL(`${API_BASE}/playlistItems`);
      url.searchParams.set("id", itemId);
      await apiFetch(url.toString(), { method: "DELETE" });
    } catch {
      failed.push(itemId);
    }
  }

  state.unavailable = state.unavailable.filter(
    (item) => !selectedIds.includes(item.playlistItemId) || failed.includes(item.playlistItemId)
  );
  renderResults(state.currentPlaylist.title, Number.NaN, state.unavailable);
  el.resultsSummary.textContent = `삭제 완료: ${selectedIds.length - failed.length}개. 남은 이용 불가 영상: ${state.unavailable.length}개.`;
  if (failed.length > 0) {
    showFooterError(`${failed.length}개 항목은 삭제에 실패했습니다. 다시 시도해주세요.`);
  }
  el.btnDelete.disabled = false;
}

function exportCsv() {
  const rows = [["position", "video_id", "title", "reason", "playlist_item_id"]];
  for (const item of state.unavailable) {
    rows.push([item.position, item.videoId, item.title, item.reason, item.playlistItemId]);
  }
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `unavailable_videos_${state.currentPlaylist.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------
// 초기화 및 이벤트 바인딩
// ---------------------------------------------------------------

async function loadPlaylistsView() {
  showView("playlists");
  el.playlistList.innerHTML = "";
  clearFooterError();
  try {
    const playlists = await fetchMyPlaylists();
    renderPlaylists(playlists);
  } catch (err) {
    showFooterError(err.message);
  }
}

async function connect() {
  el.btnConnect.disabled = true;
  el.signedOutError.classList.add("hidden");
  try {
    state.token = await requestAccessToken({ silent: false });
    const info = await apiFetch(`${API_BASE}/channels?part=snippet&mine=true`);
    const channelTitle = info.items?.[0]?.snippet?.title;
    if (channelTitle) {
      el.account.textContent = channelTitle;
      el.account.classList.remove("hidden");
    }
    await loadPlaylistsView();
  } catch (err) {
    el.signedOutError.textContent = err.message;
    el.signedOutError.classList.remove("hidden");
  } finally {
    el.btnConnect.disabled = false;
  }
}

el.btnConnect.addEventListener("click", connect);
el.btnRefresh.addEventListener("click", loadPlaylistsView);
el.btnBack.addEventListener("click", loadPlaylistsView);
el.btnExport.addEventListener("click", exportCsv);
el.btnDelete.addEventListener("click", deleteSelected);
el.btnSelectAll.addEventListener("click", () => {
  const boxes = el.resultsList.querySelectorAll('input[type="checkbox"]');
  const allChecked = Array.from(boxes).every((cb) => cb.checked);
  boxes.forEach((cb) => (cb.checked = !allChecked));
});

// Google Identity Services 스크립트가 로드된 뒤 토큰 클라이언트 초기화
window.addEventListener("load", () => {
  if (typeof google === "undefined" || !google.accounts) {
    showFooterError("구글 로그인 스크립트를 불러오지 못했습니다. 새로고침해보세요.");
    return;
  }
  initTokenClient();
});
