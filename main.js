const axios = require('axios');

const API_BASE_URL = 'http://localhost:27232';

function showMessage(text, type = 'error') {
  const messageEl = document.getElementById('message');
  if (messageEl) {
    messageEl.textContent = text;
    messageEl.className = type;
    setTimeout(() => {
      messageEl.textContent = '';
      messageEl.className = '';
    }, 5000);
  } else {
    if (typeof window !== 'undefined') {
      alert(text);
    }
  }
}

function isToday(dateStr) {
  const today = new Date().toISOString().split('T')[0];
  return dateStr === today;
}

function canGenerateToday() {
  const lastDate = localStorage.getItem('lastGenerateDate');
  return !lastDate || !isToday(lastDate);
}

function setGeneratedToday() {
  const today = new Date().toISOString().split('T')[0];
  localStorage.setItem('lastGenerateDate', today);
}

async function callLxApi(endpoint, method = 'GET', data = {}) {
  try {
    const url = `${API_BASE_URL}${endpoint}`;
    const response = await axios({
      url,
      method,
      data,
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error('[智能推荐插件] API 请求失败:', error.message);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      showMessage('无法连接开放API，请检查服务是否开启', 'error');
    } else {
      showMessage(`API 请求失败: ${error.message}`, 'error');
    }
    return null;
  }
}

async function getSeedSongs() {
  try {
    const data = await callLxApi('/playlist/list');
    const playlists = data?.list || data || [];
    if (playlists.length === 0) {
      showMessage('无法获取歌单列表', 'error');
      return [];
    }
    
    const targetPlaylist = playlists.find(playlist => playlist.name === '试听列表');
    if (!targetPlaylist) {
      showMessage('未找到"试听列表"歌单，请先创建', 'error');
      return [];
    }
    
    const songsData = await callLxApi(`/playlist/${targetPlaylist.id}/songs`);
    const songList = songsData?.list || songsData || [];
    if (!Array.isArray(songList) || songList.length === 0) {
      showMessage('无法获取试听列表的歌曲', 'error');
      return [];
    }
    return songList.slice(0, 5);
  } catch (error) {
    console.error('[智能推荐插件] 获取种子歌曲失败:', error.message);
    showMessage('获取种子歌曲失败: ' + error.message, 'error');
    return [];
  }
}

async function getSimilarSongs(songId, limit = 10) {
  try {
    // 先获取歌曲详情，拿到歌手名
    const songDetail = await callLxApi(`/song/${songId}`);
    if (!songDetail || !songDetail.singer) {
      console.warn('[智能推荐] 无法获取歌曲详情，用空列表');
      return [];
    }
    
    // 用歌手名搜索其他歌曲作为"相似"推荐
    const searchResult = await callLxApi(`/search?keywords=${encodeURIComponent(songDetail.singer)}&type=1`);
    const songs = searchResult?.result?.songs || searchResult?.data?.songs || [];
    
    // 去掉自己
    const similar = songs.filter(s => s.id !== songId);
    return similar.slice(0, limit);
  } catch (error) {
    console.error('[智能推荐] 获取相似歌曲失败:', error.message);
    return [];
  }
}

function loadBlacklist() {
  try {
    const saved = localStorage.getItem('blacklist');
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        artists: (parsed?.artists || []).map(a => a.toLowerCase()),
        albums: (parsed?.albums || []).map(a => a.toLowerCase()),
        keywords: (parsed?.keywords || []).map(k => k.toLowerCase()),
      };
    }
  } catch (e) {
    console.error('[智能推荐插件] 读取黑名单失败:', e.message);
  }
  return { artists: [], albums: [], keywords: [] };
}

function isInBlacklist(song, blacklist) {
  const singer = (song.singer || '').toLowerCase();
  const album = (song.album || '').toLowerCase();
  const name = (song.name || '').toLowerCase();

  for (const artist of blacklist.artists || []) {
    if (singer.includes(artist.toLowerCase())) {
      return true;
    }
  }

  for (const albumName of blacklist.albums || []) {
    if (album.includes(albumName.toLowerCase())) {
      return true;
    }
  }

  for (const keyword of blacklist.keywords || []) {
    if (name.includes(keyword.toLowerCase())) {
      return true;
    }
  }

  return false;
}

function getRecentDiscoverPlaylist() {
  try {
    if (typeof window === 'undefined' || !localStorage) {
      return [];
    }
    const playlistData = localStorage.getItem('recent_discover_playlist');
    if (playlistData) {
      return JSON.parse(playlistData);
    }
  } catch (e) {
    console.error('[智能推荐插件] 读取最近发现歌单失败:', e.message);
  }
  return [];
}

function isInRecentDiscover(song, recentPlaylist) {
  if (!recentPlaylist || recentPlaylist.length === 0) {
    return false;
  }
  return recentPlaylist.some(item => item.id === song.id);
}

function loadHistory() {
  const history = {};
  try {
    if (typeof window === 'undefined' || !localStorage) {
      return history;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('recommend_history_')) {
        history[key] = JSON.parse(localStorage.getItem(key));
      }
    }
  } catch (e) {
    console.error('[智能推荐插件] 读取历史记录失败:', e.message);
  }
  return history;
}

function isRecommendedInLast30Days(song, history) {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  for (const key in history) {
    const datePart = key.replace('recommend_history_', '');
    const date = new Date(datePart);
    if (!isNaN(date) && date >= thirtyDaysAgo) {
      const songs = history[key];
      if (songs && songs.some(s => s.id === song.id)) {
        return true;
      }
    }
  }
  return false;
}

function filterSongs(allSimilarSongs, userSettings) {
  const blacklist = loadBlacklist();
  const recentPlaylist = getRecentDiscoverPlaylist();
  const history = loadHistory();

  let filtered = allSimilarSongs.filter(song => {
    if (!song) return false;

    if (isInBlacklist(song, blacklist)) {
      return false;
    }

    if (isInRecentDiscover(song, recentPlaylist)) {
      return false;
    }

    if (isRecommendedInLast30Days(song, history)) {
      return false;
    }

    return true;
  });

  return filtered;
}

async function generateDailyRecommend(forceRefresh = false) {
  try {
    if (!forceRefresh && !canGenerateToday()) {
      showMessage('今日推荐已生成，点击"立即刷新"可重新生成', 'info');
      return [];
    }

    const defaultSettings = {
      dailyCount: 20,
      seedCount: 5,
      maxArtist: 1,
      recommendMode: 'mixed',
      autoPlay: false,
      engineName: 'default'
    };
    
    let userSettings = defaultSettings;
    if (typeof window !== 'undefined' && localStorage) {
      const saved = localStorage.getItem('smartRecommendSettings');
      if (saved) {
        userSettings = { ...defaultSettings, ...JSON.parse(saved) };
      }
    }

    const engine = window.SmartRecommend.engines[userSettings.engineName || 'default'];
    if (!engine) {
      showMessage('未找到推荐引擎', 'error');
      return [];
    }

    const seeds = await engine.getSeed();
    if (seeds.length === 0) {
      showMessage('未获取到种子歌曲，请确保试听列表中有歌曲', 'error');
      return [];
    }

    let candidates = await engine.getCandidates(seeds);
    if (candidates.length === 0) {
      showMessage('未找到相似歌曲', 'error');
      return [];
    }

    let filtered = engine.filter(candidates, userSettings);
    let final = engine.postProcess(filtered, userSettings);

    if (final.length === 0) {
      showMessage('经过过滤后没有可用的推荐歌曲', 'info');
      return [];
    }

    const todayStr = new Date().toISOString().split('T')[0];  // "2026-05-07"
    const historyKey = `recommend_history_${todayStr}`;
    if (typeof window !== 'undefined' && localStorage) {
      const thirtyDaysAgoStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('recommend_history_')) {
          const keyDate = key.replace('recommend_history_', '');
          if (keyDate < thirtyDaysAgoStr) {
            localStorage.removeItem(key);
          }
        }
      });
      localStorage.setItem(historyKey, JSON.stringify(final));
      localStorage.setItem('recent_discover_playlist', JSON.stringify(final));
      setGeneratedToday();
    }

    showMessage(`推荐生成成功，共 ${final.length} 首歌曲`, 'success');
    return final;
  } catch (error) {
    console.error('[智能推荐插件] 推荐生成失败：', error.message);
    showMessage('推荐生成失败: ' + error.message, 'error');
    return [];
  }
}

function registerMenuItems() {
  if (typeof window !== 'undefined' && window.lx && window.lx.menu) {
    try {
      window.lx.menu.add({
        id: 'smartRecommend',
        label: '🎵 智能推荐',
        icon: '',
        click: () => {
          window.location.href = 'index.html';
        }
      });

      window.lx.menu.add({
        id: 'smartRecommendSettings',
        label: '⚙️ 推荐设置',
        icon: '',
        click: () => {
          window.location.href = 'settings.html';
        }
      });

      window.lx.menu.add({
        id: 'smartRecommendHistory',
        label: '📜 推荐历史',
        icon: '',
        click: () => {
          window.location.href = 'history.html';
        }
      });

      window.lx.menu.add({
        id: 'smartRecommendBlacklist',
        label: '🚫 推荐黑名单',
        icon: '',
        click: () => {
          window.location.href = 'blacklist.html';
        }
      });

      console.log('[智能推荐插件] 菜单注册成功');
    } catch (error) {
      console.error('[智能推荐插件] 菜单注册失败:', error.message);
      renderNavButtons();
    }
  } else {
    renderNavButtons();
  }
}

function renderNavButtons() {
  const navContainer = document.createElement('div');
  navContainer.className = 'nav-buttons';
  navContainer.innerHTML = `
    <button class="nav-btn" onclick="window.location.href='index.html'">🎵 智能推荐</button>
    <button class="nav-btn" onclick="window.location.href='settings.html'">⚙️ 推荐设置</button>
    <button class="nav-btn" onclick="window.location.href='history.html'">📜 推荐历史</button>
    <button class="nav-btn" onclick="window.location.href='blacklist.html'">🚫 推荐黑名单</button>
  `;
  
  const app = document.getElementById('app');
  if (app) {
    app.insertBefore(navContainer, app.firstChild);
  }
}

if (typeof window !== 'undefined') {
  window.SmartRecommend = {
    callLxApi,
    getSeedSongs,
    getSimilarSongs,
    filterSongs,
    generateDailyRecommend,
    canGenerateToday,
    setGeneratedToday,
    engines: {},
    registerEngine: function(name, engine) {
      this.engines[name] = engine;
    }
  };
}

const defaultEngine = {
  name: 'default',
  getSeed: getSeedSongs,
  getCandidates: async (seeds) => {
    const results = await Promise.all(seeds.filter(s => s.id).map(s => getSimilarSongs(s.id, 10)));
    return results.flat();
  },
  filter: filterSongs,
  postProcess: (songs, userSettings) => {
    const seen = new Set();
    const uniqueSongs = songs.filter(song => {
      const key = `${song.id}-${song.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const dailyCount = userSettings.dailyCount || 20;
    return uniqueSongs.slice(0, dailyCount);
  }
};

if (typeof window !== 'undefined') {
  window.SmartRecommend.registerEngine('default', defaultEngine);
}

async function getOrCreatePlaylist(name) {
  try {
    const data = await callLxApi('/playlist/list');
    const playlists = data?.list || data || [];
    if (!Array.isArray(playlists) || playlists.length === 0) {
      showMessage('无法获取歌单列表', 'error');
      return null;
    }

    const existing = playlists.find(p => p.name === name);
    if (existing) {
      return existing;
    }

    const created = await callLxApi('/playlist/create', 'POST', { name });
    if (!created || !created.id) {
      showMessage('创建歌单失败，未返回有效ID', 'error');
      return null;
    }
    return created;
  } catch (error) {
    console.error('[智能推荐插件] 获取或创建歌单失败:', error.message);
    showMessage('获取或创建歌单失败: ' + error.message, 'error');
    return null;
  }
}

async function clearPlaylist(playlistId) {
  try {
    const result = await callLxApi(`/playlist/${playlistId}/clear`, 'POST');
    if (!result) {
      showMessage('清空歌单失败', 'error');
      return false;
    }
    return true;
  } catch (error) {
    console.error('[智能推荐插件] 清空歌单失败:', error.message);
    showMessage('清空歌单失败: ' + error.message, 'error');
    return false;
  }
}

async function addSongsToPlaylist(playlistId, songIds) {
  try {
    const result = await callLxApi(`/playlist/${playlistId}/add`, 'POST', { songIds: songIds });
    if (!result) {
      showMessage('添加歌曲失败', 'error');
      return false;
    }
    return true;
  } catch (error) {
    console.error('[智能推荐插件] 添加歌曲失败:', error.message);
    showMessage('添加歌曲失败: ' + error.message, 'error');
    return false;
  }
}

async function playSong(songId) {
  try {
    const result = await callLxApi('/player/play', 'POST', { id: songId });
    if (!result) {
      showMessage('播放失败', 'error');
      return false;
    }
    return true;
  } catch (error) {
    console.error('[智能推荐插件] 播放失败:', error.message);
    showMessage('播放失败: ' + error.message, 'error');
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    callLxApi,
    getSeedSongs,
    getSimilarSongs,
    filterSongs,
    generateDailyRecommend,
    getOrCreatePlaylist,
    clearPlaylist,
    addSongsToPlaylist,
    playSong,
  };
}

if (typeof window !== 'undefined') {
  window.SmartRecommend = {
    ...window.SmartRecommend,
    getOrCreatePlaylist,
    clearPlaylist,
    addSongsToPlaylist,
    playSong,
  };
}

console.log('[智能推荐插件] 插件已加载。');

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    registerMenuItems();

    const playBtn = document.getElementById('playBtn');
    const generateBtn = document.getElementById('generateBtn');
    const clearBtn = document.getElementById('clearBtn');

    async function handleGenerateAndPlay(autoPlay = false, forceRefresh = false) {
      const btn = autoPlay ? playBtn : generateBtn;
      const originalText = btn.textContent;
      btn.textContent = '正在生成...';
      btn.disabled = true;

      try {
        const recommendSongs = await generateDailyRecommend(forceRefresh);
        if (recommendSongs.length === 0) {
          return;
        }

        const playlist = await getOrCreatePlaylist('最近发现');
        if (!playlist || !playlist.id) {
          return;
        }

        await clearPlaylist(playlist.id);

        const songIds = recommendSongs.map(song => song.id).filter(Boolean);
        await addSongsToPlaylist(playlist.id, songIds);

        if (autoPlay && songIds.length > 0) {
          await playSong(songIds[0]);
        }

        console.log('[智能推荐插件] 操作完成');
      } catch (error) {
        console.error('[智能推荐插件] 操作失败：', error.message);
        showMessage('操作失败: ' + error.message, 'error');
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }

    playBtn?.addEventListener('click', () => handleGenerateAndPlay(true, false));
    generateBtn?.addEventListener('click', () => handleGenerateAndPlay(false, true));

    clearBtn?.addEventListener('click', async () => {
      const originalText = clearBtn.textContent;
      clearBtn.textContent = '正在清空...';
      clearBtn.disabled = true;

      try {
        const playlists = await callLxApi('/playlist/list');
        if (!playlists || !Array.isArray(playlists)) {
          showMessage('无法获取歌单列表', 'error');
          return;
        }

        const targetPlaylist = playlists.find(p => p.name === '最近发现');
        if (!targetPlaylist) {
          showMessage('未找到"最近发现"歌单', 'error');
          return;
        }

        await clearPlaylist(targetPlaylist.id);
        showMessage('最近发现歌单已清空', 'success');
      } catch (error) {
        console.error('[智能推荐插件] 清空失败：', error.message);
        showMessage('清空失败: ' + error.message, 'error');
      } finally {
        clearBtn.textContent = originalText;
        clearBtn.disabled = false;
      }
    });

    if (!canGenerateToday()) {
      const lastDate = localStorage.getItem('lastGenerateDate');
      showMessage(`今日推荐已生成（${lastDate}），点击"立即刷新"可重新生成`, 'info');
    }
  });
}
