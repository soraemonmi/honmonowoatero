const socket = io();
let state = {
  me: null,
  room: null,
  isHost: false,
  phase: null,
  settings: {},
  posts: [],
  round: null,
  role: null,
  scoreboard: [],
  votes: [],
  myVoted: false,
  playerCount: 0,
  customTopicCount: 0,
};

const $ = (s) => document.querySelector(s);
function show(id) {
  ['home', 'lobby', 'game'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id));
}
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.remove('hidden');
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => el.classList.add('hidden'), 2500);
}
function roleLabel(r) {
  return ({ real: '本物', fake: '偽物（真似する人）', guesser: '当てる人', spectator: '観戦' })[r] || '観戦';
}
function escapeHtml(x) {
  return String(x).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}
function renderPlayers(players) {
  // Host identity is intentionally never displayed in the shared player list.
  $('#playersList').innerHTML = players.map((p) =>
    `<div class="player">
      <b>プレイヤー${p.anon}</b>
      <div class="small">${!p.connected ? '（切断）' : ''}</div>
    </div>`
  ).join('');
  state.playerCount = players.filter((p) => p.connected).length;
  $('#playerCount').textContent = `${state.playerCount}/20`;
}
function renderScores() {
  const s = [...(state.scoreboard || [])].sort((a, b) => (b.earnedPoints - a.earnedPoints) || (b.rate - a.rate) || (b.score - a.score));
  $('#scoreboard').innerHTML = `<div class="scoreHead"><span></span><span>プレイヤー</span><span>ポイント</span><span>成功率</span></div>` + s.map((p, i) =>
    `<div class="scoreRow"><b>${i + 1}</b><div>${escapeHtml(p.name || '')}</div><div>${Math.round(p.earnedPoints ?? p.score ?? 0)}pt</div><div>${p.rate}%</div></div>`
  ).join('');
}
function renderLobbySettings() {
  const s = state.settings;
  const answerCount = s.answerCount ?? Math.max(0, (state.playerCount || 0) - Number(s.fakeCount || 0));
  $('#hostSettings').innerHTML = state.isHost
    ? `<div><label>偽物人数<input id="fakeCount" type="number" min="1" value="${s.fakeCount}"></label></div>
       <div class="small">回答人数：${answerCount}人（ルーム内人数 − 偽物人数）</div>
       <div><label>入力時間(秒)<input id="writeSeconds" type="number" min="15" max="120" value="${s.writeSeconds}"></label></div>`
    : `<div>偽物：${s.fakeCount}人 / 回答人数：${answerCount}人 / 入力時間：${s.writeSeconds}秒</div>`;
  $('#startBtn').classList.toggle('hidden', !state.isHost);
  $('#customTopicStatus').textContent = `${state.customTopicCount || 0}個のお題が追加されています。`;
  if (state.isHost) {
    ['fakeCount', 'writeSeconds'].forEach((id) => {
      $('#' + id).onchange = () => socket.emit('room:settings', {
        fakeCount: +$('#fakeCount').value,
        writeSeconds: +$('#writeSeconds').value,
      });
    });
  }
}
function renderPosts() {
  if (state.phase === 'writing') {
    $('#posts').innerHTML = '<div class="small">本物と偽物が投稿中です。全員の投稿がそろうまで内容は表示されません。</div>';
    return;
  }
  $('#posts').innerHTML = state.posts.map((p) =>
    `<div class="post">
      <div class="anon">プレイヤー${p.anon}</div>
      <div class="text">${escapeHtml(p.text)}</div>
    </div>`
  ).join('') || '<div class="small">まだ投稿はありません。</div>';
}
function renderPostForm(d) {
  const pf = $('#postForm');
  const canPost = d.phase === 'writing' && (d.role === 'real' || d.role === 'fake');
  const alreadyPosted = state.posts.some((p) => p.id === state.me?.id || p.anon === state.me?.anon);
  if (!canPost || alreadyPosted) {
    pf.innerHTML = '';
    return;
  }
  pf.innerHTML = `<textarea id="postText" rows="3" maxlength="200" placeholder="お題について、いつもの自分なら書きそうな文章を入力"></textarea>
                  <button id="submitPost" class="primary wide">投稿する</button>`;
  $('#submitPost').onclick = () => {
    const text = $('#postText').value.trim();
    if (!text) return toast('文章を入力してください');
    $('#submitPost').disabled = true;
    socket.emit('post:submit', { text });
  };
}
function renderVotePanel(d) {
  const panel = $('#votePanel');
  panel.classList.toggle('hidden', d.phase !== 'voting');
  if (d.phase !== 'voting') return;

  if (d.role === 'fake') {
    $('#voteGuide').textContent = `投票受付中：${d.voteCount}/${d.guesserCount}票。結果は投票終了後に公開されます。`;
    $('#voteChoices').innerHTML = '<div class="small">偽物は投票できません。</div>';
    return;
  }

  $('#voteGuide').textContent = state.myVoted
    ? '投票しました。結果発表を待ってください。'
    : '本物だと思う投稿を1つ選んでください。';

  if (state.myVoted) {
    $('#voteChoices').innerHTML = '<div class="small">投票済みです。</div>';
    return;
  }

  $('#voteChoices').innerHTML = (d.posts || []).map((p) =>
    `<button class="voteChoice" data-id="${escapeHtml(p.id)}">
      <b>プレイヤー${p.anon}</b><br>${escapeHtml(p.text)}
    </button>`
  ).join('');

  $('#voteChoices').querySelectorAll('.voteChoice').forEach((b) => {
    b.onclick = () => {
      state.myVoted = true;
      $('#voteChoices').querySelectorAll('.voteChoice').forEach((x) => { x.disabled = true; });
      socket.emit('vote:submit', { targetId: b.dataset.id });
    };
  });
}
function renderPrompt(d) {
  const isTargetPrompt = d.role === 'guesser' || d.role === 'spectator';
  if (isTargetPrompt && d.guessTargetName) {
    $('#topicCard').innerHTML = `
      <div class="topicLabel">このラウンドのお題</div>
      <div class="topicMain">${escapeHtml(d.topic)}</div>
      <div class="guessPrompt">「${escapeHtml(d.guessTargetName)}」はどっち？</div>`;
  } else {
    $('#topicCard').innerHTML = `
      <div class="topicLabel">お題</div>
      <div class="topicMain">${escapeHtml(d.topic)}</div>`;
  }
}
function renderGame(d) {
  show('game');
  state.posts = d.posts || [];
  state.votes = [];
  state.myVoted = false;
  state.phase = d.phase;
  state.role = d.role;
  state.round = d;
  state.scoreboard = d.scoreboard || [];

  $('#roundText').textContent = `ROUND ${d.number}`;
  $('#phaseText').textContent = d.phase === 'writing' ? '投稿' : d.phase === 'voting' ? '投票' : d.phase === 'reveal' ? '結果' : '観戦';
  $('#roleTitle').innerHTML = `<div class="roleAccent">あなたは「${roleLabel(d.role)}」</div>`;

  let info = '';
  if (d.role === 'real') info = `お題を見て、いつもの自分なら何を書くか入力してください。<br>偽物：${(d.roleNames.fakeNames || []).join('、')}`;
  if (d.role === 'fake') info = `本物：${d.roleNames.realName}<br>本物の投稿は見えません。「この人なら何を書く？」と想像して入力してください。`;
  if (d.role === 'guesser') info = `「${escapeHtml(d.guessTargetName || '')}」が本物だと思う匿名投稿を当ててください。`;
  if (d.role === 'spectator') info = '観戦中です。投稿・投票の進行を見られます。';
  $('#roleInfo').innerHTML = info;

  renderPrompt(d);
  renderPosts();
  renderPostForm(d);
  renderVotePanel(d);
  $('#revealPanel').classList.add('hidden');
  $('#spectatorText').textContent = d.role === 'spectator' ? '観戦中です。結果発表まで役割は秘密です。' : 'ゲームの進行を確認できます。';
  renderScores();
}
function renderReveal(d) {
  $('#revealPanel').classList.remove('hidden');
  $('#revealPanel').innerHTML = `
    <h2>結果発表！</h2>
    <p><b>本物：</b>プレイヤー${findAnon(d.realId)}（${escapeHtml(d.realName || '')}）</p>
    <p><b>偽物：</b>${(d.fakeNames || []).map((x) => escapeHtml(x)).join('、') || 'なし'}</p>
    <p><b>当てる担当：</b>${(d.guesserNames || []).map((x) => escapeHtml(x)).join('、') || 'なし'}</p>
    <div class="revealGrid">
      ${(d.posts || []).map((p) => `
        <div class="revealRole">
          <b>プレイヤー${p.anon}</b>
          <p class="text">${escapeHtml(p.text)}</p>
          ${p.id === d.realId ? '<strong>本物</strong>' : d.fakeIds.includes(p.id) ? '<strong>偽物</strong>' : ''}
        </div>`).join('')}
    </div>
    <h3>投票結果</h3>
    ${(d.voteResults || []).map((v) => `
      <div class="liveVote">
        <b>${escapeHtml(v.voterName)}</b> → プレイヤー${v.targetAnon}
        ${v.success ? '✅ 本物を正解' : '❌ 不正解'}
      </div>`).join('') || '<div class="small">投票なし</div>'}
    <div class="row between" style="margin-top:14px">
      ${state.isHost ? '<button id="nextBtn" class="primary">次のラウンド</button>' : ''}
      <span class="small">本物を正解：+1pt / 本物が当てられる：+1pt / 偽物が本物だと判断される：+2pt</span>
    </div>`;
  $('#nextBtn')?.addEventListener('click', () => socket.emit('game:next'));
}
function renderLiveVotes() {
  $('#liveVotes').innerHTML = state.votes.length
    ? `<div class="small">投票は受付中です。誰が誰に投票したかは結果発表まで非公開です。</div>`
    : '';
}
function findAnon(id) {
  const source = state.round?.candidatePlayers || [];
  return source.find((x) => x.id === id)?.anon || '?';
}

$('#createBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  socket.emit('room:create', { name, fakeCount: 1, guesserCount: 1, writeSeconds: 45 });
};
$('#joinBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  const code = $('#codeInput').value.trim();
  socket.emit('room:join', { name, code });
};
$('#copyBtn').onclick = () => navigator.clipboard?.writeText(state.room).then(() => toast('ルームコードをコピーしました'));
$('#startBtn').onclick = () => socket.emit('game:start');

socket.on('topic:added', (msg) => {
  $('#customTopicInput').value = '';
  toast(msg);
});

socket.on('error:msg', (msg) => {
  state.myVoted = false;
  toast(msg);
});
socket.on('room:joined', (d) => {
  state.me = d.me;
  state.room = d.code;
  state.isHost = d.isHost;
  state.settings = d.settings;
  state.customTopicCount = d.customTopicCount || 0;
  $('#roomBadge').textContent = d.code;
  $('#roomBadge').classList.remove('hidden');
  $('#roomCodeText').textContent = `ルームコード：${d.code}`;
  $('#roleInfo').textContent = '';
  show('lobby');
  renderPlayers(d.players);
  renderLobbySettings();
});
socket.on('room:update', (d) => {
  state.settings = d.settings;
  state.customTopicCount = d.customTopicCount || 0;
  renderPlayers(d.players);
  state.scoreboard = d.scores || [];
  renderScores();
  if (d.phase === 'lobby') {
    show('lobby');
    renderLobbySettings();
  }
});

socket.on('host:status', (d) => {
  state.isHost = !!d.isHost;
  if (state.phase === 'lobby') renderLobbySettings();
});

socket.on('round:update', (d) => renderGame(d));
socket.on('round:postCount', (d) => {
  $('#spectatorText').textContent = `投稿済み ${d.count}/${d.total}`;
});
socket.on('vote:count', (d) => {
  $('#voteGuide').textContent = state.myVoted
    ? `投票しました。投票済み ${d.count}/${d.total}票`
    : `投票済み ${d.count}/${d.total}票`;
});
socket.on('round:reveal', (d) => {
  state.scoreboard = d.scoreboard || [];
  state.round = { ...(state.round || {}), candidatePlayers: d.candidatePlayers || [] };
  renderReveal(d);
  renderScores();
});
socket.on('game:ended', (d) => {
  state.scoreboard = d.scoreboard || [];
  renderScores();
  toast('ゲーム終了');
});

setInterval(() => {
  if (state.round?.deadline) {
    const sec = Math.max(0, Math.ceil((state.round.deadline - Date.now()) / 1000));
    $('#timer').textContent = state.phase === 'writing' ? `残り ${sec}秒` : '';
  }
}, 250);
