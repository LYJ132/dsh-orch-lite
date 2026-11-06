/* Voice Party — i18n (zh-CN / en) */
(function (global) {
  'use strict';

  var DICT = {
    zh: {
      'net.offline': '离线',
      'net.online': '已连接',
      'net.connecting': '连接中',
      'net.error': '连接失败',

      'home.tagline': '用声音控制小鸟，和朋友一起玩',
      'home.create': '创建房间',
      'home.join': '加入',
      'home.codePh': '房间码',
      'home.or': '或',
      'home.solo': '单人练习（无需联机）',
      'home.sim': '模拟输入（无麦克风）',
      'home.hint': '需要麦克风权限；iOS 请先点击按钮再授权。也可开启模拟输入试玩。',

      'lobby.roomCode': '房间码',
      'lobby.share': '复制邀请链接',
      'lobby.copied': '已复制邀请链接',
      'lobby.mode': '游戏模式',
      'lobby.control': '我的控制方式',
      'lobby.players': '玩家',
      'lobby.ready': '准备',
      'lobby.unready': '取消准备',
      'lobby.start': '开始游戏',
      'lobby.leave': '离开房间',
      'lobby.hint.wait': '等待房主开始游戏',
      'lobby.hint.needDual': '双人模式需要 2 名玩家',
      'lobby.hint.needReady': '等待所有玩家准备',
      'lobby.hint.ready': '所有人都已准备，可以开始',
      'lobby.hint.hostOnly': '只有房主可以开始游戏',
      'lobby.hint.designer': '你是关卡设计者，可编辑关卡',
      'lobby.role.host': '房主',
      'lobby.role.designer': '设计者',
      'lobby.role.up': '控上',
      'lobby.role.down': '控下',
      'lobby.role.player': '玩家',
      'lobby.state.joined': '已加入',
      'lobby.state.ready': '已准备',
      'lobby.state.playing': '游戏中',
      'lobby.state.left': '已退出',

      'mode.solo': '单人飞鸟',
      'mode.soloDesc': '一个人控制',
      'mode.dual': '双人协作飞鸟',
      'mode.dualDesc': 'A 控上 / B 控下',

      'ctl.pitch': '音调',
      'ctl.volume': '音量',

      'designer.title': '自定义关卡',
      'designer.drawHint': '用手指画一条通道中心线',
      'designer.clear': '清除',
      'designer.reroll': '换一批障碍',
      'designer.lock': '锁定关卡',
      'designer.unlock': '解锁关卡',
      'designer.state.draft': '草稿 · 可编辑',
      'designer.state.locked': '已锁定 · 本局生效',
      'designer.meta': '障碍 {n} 个 · 通道约 {g}px · {s}',
      'designer.meta.empty': '先画一条中心线，系统会自动生成上下障碍。',
      'designer.meta.relaxed': '通道已自动放宽以保证可通关',
      'designer.reverted': '关卡已回到草稿，可继续调整',
      'designer.needDraw': '请先画一条中心线',
      'designer.onlyDesigner': '只有设计者或房主可以编辑关卡',
      'designer.take': '由我设计',

      'diff.easy': '简单',
      'diff.normal': '普通',
      'diff.hard': '困难',

      'game.score': '分',
      'game.quit': '退出',
      'game.paused': '已暂停 · 点按继续',
      'game.state.up': '上抬',
      'game.state.down': '下压',
      'game.state.hold': '保持',
      'game.state.silent': '无声',
      'game.state.hint': '持续发声才能保持前进',
      'game.mode.solo': '单人飞鸟',
      'game.mode.dual': '双人协作',
      'game.p1': 'P1 控上',
      'game.p2': 'P2 控下',
      'game.you': '你',
      'game.over': '撞到了！',
      'game.countdown': '准备…',
      'game.hostAway': '房主已切到后台 · 本局已暂停',
      'game.hostLost': '与房主失联 · 正在等待恢复',

      'result.title': '本局结果',
      'result.score': '得分',
      'result.passed': '通过障碍',
      'result.dist': '飞行距离',
      'result.synergy': '配合度',
      'result.retry': '再来一局',
      'result.back': '回到房间',
      'result.note.designer': '关卡已回到草稿，可调整后重开',
      'result.note.host': '已回到房间，关卡可继续编辑',
      'result.soloHint': '单人模式：尝试用升高/降低音调控制角度',

      'err.mic': '无法获取麦克风权限，请检查浏览器设置',
      'err.micInsecure': '麦克风需要 HTTPS 或 localhost 环境',
      'err.signal': '无法连接信令服务器，请稍后再试',
      'err.roomFull': '房间已存在，请换一个房间码',
      'err.noRoom': '房间不存在或已关闭',
      'err.noPeer': 'PeerJS 未加载',
      'err.disconnected': '连接已断开'
    },

    en: {
      'net.offline': 'Offline',
      'net.online': 'Connected',
      'net.connecting': 'Connecting',
      'net.error': 'Link failed',

      'home.tagline': 'Fly a bird with your voice. Play with friends.',
      'home.create': 'Create room',
      'home.join': 'Join',
      'home.codePh': 'Room code',
      'home.or': 'or',
      'home.solo': 'Solo practice (no network)',
      'home.sim': 'Simulated input (no mic)',
      'home.hint': 'Microphone permission required. On iOS, tap a button first, then allow. Simulated input works without a mic.',

      'lobby.roomCode': 'Room code',
      'lobby.share': 'Copy invite link',
      'lobby.copied': 'Invite link copied',
      'lobby.mode': 'Game mode',
      'lobby.control': 'My control',
      'lobby.players': 'Players',
      'lobby.ready': 'Ready',
      'lobby.unready': 'Not ready',
      'lobby.start': 'Start game',
      'lobby.leave': 'Leave room',
      'lobby.hint.wait': 'Waiting for the host to start',
      'lobby.hint.needDual': 'Dual mode needs 2 players',
      'lobby.hint.needReady': 'Waiting for all players to ready up',
      'lobby.hint.ready': 'Everyone is ready',
      'lobby.hint.hostOnly': 'Only the host can start',
      'lobby.hint.designer': 'You are the level designer — you can edit the level',
      'lobby.role.host': 'Host',
      'lobby.role.designer': 'Designer',
      'lobby.role.up': 'UP',
      'lobby.role.down': 'DOWN',
      'lobby.role.player': 'Player',
      'lobby.state.joined': 'Joined',
      'lobby.state.ready': 'Ready',
      'lobby.state.playing': 'Playing',
      'lobby.state.left': 'Left',

      'mode.solo': 'Solo Bird',
      'mode.soloDesc': 'One player controls',
      'mode.dual': 'Two-player Bird',
      'mode.dualDesc': 'A = up, B = down',

      'ctl.pitch': 'Pitch',
      'ctl.volume': 'Volume',

      'designer.title': 'Custom level',
      'designer.drawHint': 'Draw a centre line for the channel',
      'designer.clear': 'Clear',
      'designer.reroll': 'Re-roll obstacles',
      'designer.lock': 'Lock level',
      'designer.unlock': 'Unlock level',
      'designer.state.draft': 'Draft — editable',
      'designer.state.locked': 'Locked — used this round',
      'designer.meta': '{n} obstacles · gap ≈ {g}px · {s}',
      'designer.meta.empty': 'Draw a centre line and obstacles are generated automatically.',
      'designer.meta.relaxed': 'Gap widened automatically to keep it clearable',
      'designer.reverted': 'Level reverted to draft — keep editing',
      'designer.needDraw': 'Draw a centre line first',
      'designer.onlyDesigner': 'Only the designer or host can edit the level',
      'designer.take': 'I am the designer',

      'diff.easy': 'Easy',
      'diff.normal': 'Normal',
      'diff.hard': 'Hard',

      'game.score': 'pts',
      'game.quit': 'Quit',
      'game.paused': 'Paused — tap to resume',
      'game.state.up': 'UP',
      'game.state.down': 'DOWN',
      'game.state.hold': 'HOLD',
      'game.state.silent': 'SILENT',
      'game.state.hint': 'Keep voicing to keep flying',
      'game.mode.solo': 'Solo Bird',
      'game.mode.dual': 'Co-op Bird',
      'game.p1': 'P1 up',
      'game.p2': 'P2 down',
      'game.you': 'you',
      'game.over': 'Crash!',
      'game.countdown': 'Get ready…',
      'game.hostAway': 'Host left the foreground · round paused',
      'game.hostLost': 'Lost contact with the host · waiting…',

      'result.title': 'Round result',
      'result.score': 'Score',
      'result.passed': 'Obstacles',
      'result.dist': 'Distance',
      'result.synergy': 'Synergy',
      'result.retry': 'Play again',
      'result.back': 'Back to room',
      'result.note.designer': 'Level reverted to draft — tweak and replay',
      'result.note.host': 'Back in the room, the level stays editable',
      'result.soloHint': 'Solo: try raising and lowering your pitch to steer',

      'err.mic': 'Microphone unavailable — check browser permission',
      'err.micInsecure': 'Microphone needs HTTPS or localhost',
      'err.signal': 'Cannot reach the signalling server, try later',
      'err.roomFull': 'Room already exists, pick another code',
      'err.noRoom': 'Room not found or closed',
      'err.noPeer': 'PeerJS failed to load',
      'err.disconnected': 'Connection lost'
    }
  };

  var lang = 'zh';
  try {
    var saved = localStorage.getItem('vp_lang');
    if (saved && DICT[saved]) lang = saved;
    else if ((navigator.language || '').toLowerCase().indexOf('zh') !== 0) lang = 'en';
  } catch (e) { /* ignore */ }

  var I18N = {
    get lang() { return lang; },
    set: function (l) {
      if (!DICT[l]) return;
      lang = l;
      try { localStorage.setItem('vp_lang', l); } catch (e) {}
      document.documentElement.lang = (l === 'zh') ? 'zh-CN' : 'en';
      I18N.apply();
    },
    toggle: function () { I18N.set(lang === 'zh' ? 'en' : 'zh'); },
    t: function (key, vars) {
      var s = (DICT[lang] && DICT[lang][key]) || (DICT.zh[key]) || key;
      if (vars) {
        Object.keys(vars).forEach(function (k) {
          s = s.split('{' + k + '}').join(String(vars[k]));
        });
      }
      return s;
    },
    apply: function () {
      document.querySelectorAll('[data-i18n]').forEach(function (el) {
        el.textContent = I18N.t(el.dataset.i18n);
      });
      document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
        el.placeholder = I18N.t(el.dataset.i18nPh);
      });
      var b = document.getElementById('btnLang');
      if (b) b.textContent = (lang === 'zh') ? 'EN' : '中文';
      document.dispatchEvent(new CustomEvent('vp:lang'));
    }
  };

  global.I18N = I18N;
  I18N.set(lang);
})(window);
