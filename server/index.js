const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;
const TOPICS = [
  '寝る前','朝起きたとき','お腹が空いたとき','暇なとき','学校・仕事が終わったあと','休日の朝',
  'お風呂に入る前','ご飯を食べ終わったあと','電車を待っているとき','ゲームに負けたとき','ゲームに勝ったとき',
  '布団に入ったとき','眠いとき','暑いとき','寒いとき','雨の日','月曜日の朝','めちゃくちゃ嬉しいとき',
  'めちゃくちゃ悲しいとき','イライラしたとき','驚いたとき','焦ったとき','緊張しているとき','褒められたとき',
  '怒られたとき','久しぶりの人に会ったとき','めちゃくちゃ暇なとき','好きな曲を聴いたとき'
];

const rooms = new Map();
const roleTypes = ['real','fake','guesser','spectator'];
function uid(){ return Math.random().toString(36).slice(2,10); }
function clamp(n,min,max){ return Math.max(min, Math.min(max, Number(n)||0)); }
function shuffle(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function code(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }
function publicPlayer(p){ return { id:p.id, anon:p.anon, name:p.name, connected:p.connected, isHost:p.isHost }; }
function viewerPlayer(p){ return { id:p.id, anon:p.anon, connected:p.connected, isHost:p.isHost }; }
function getRoom(code){ return rooms.get(code); }
function emitRoom(room){ io.to(room.code).emit('room:update', { code:room.code, hostId:room.hostId, phase:room.phase, settings:room.settings, players:room.players.map(viewerPlayer), round:room.round, scores:makeScoreboard(room), myRoom:true }); }
function makeScoreboard(room){
  return room.players.map(p=>({ id:p.id, anon:p.anon, score:p.score, correct:p.correct, attempts:p.attempts, rate:p.attempts?Math.round(p.correct/p.attempts*100):0 }));
}
function chooseWeighted(list, counts, need){
  const pool = [...list]; const out=[];
  for(let k=0;k<need && pool.length;k++){
    const min = Math.min(...pool.map(p=>counts[p.id]||0));
    const candidates = pool.filter(p=>(counts[p.id]||0)===min);
    const picked=candidates[Math.floor(Math.random()*candidates.length)];
    out.push(picked); pool.splice(pool.indexOf(picked),1);
  }
  return out;
}
function assignRoles(room){
  const ps = room.players.filter(p=>p.connected);
  shuffle(ps);
  const realCounts = Object.fromEntries(ps.map(p=>[p.id,p.roleCounts.real||0]));
  const fakeCounts = Object.fromEntries(ps.map(p=>[p.id,p.roleCounts.fake||0]));
  const guessCounts = Object.fromEntries(ps.map(p=>[p.id,p.roleCounts.guesser||0]));
  const realPool = ps;
  const real = chooseWeighted(realPool, realCounts,1)[0];
  const remaining1 = ps.filter(p=>p.id!==real.id);
  const fakeNeed = Math.min(room.settings.fakeCount, remaining1.length);
  const fakes = chooseWeighted(remaining1, fakeCounts, fakeNeed);
  const remaining2 = remaining1.filter(p=>!fakes.some(x=>x.id===p.id));
  const guessNeed = Math.min(room.settings.guesserCount, remaining2.length);
  const guessers = chooseWeighted(remaining2, guessCounts, guessNeed);
  ps.forEach(p=>{ p.role='spectator'; });
  real.role='real'; fakes.forEach(p=>p.role='fake'); guessers.forEach(p=>p.role='guesser');
  real.roleCounts.real++;
  fakes.forEach(p=>p.roleCounts.fake++);
  guessers.forEach(p=>p.roleCounts.guesser++);
  const targets = shuffle(ps.filter(p=>p.id!==real.id));
  // Each fake privately knows the real person's name and is asked to imitate that person's "likely" response.
  fakes.forEach(p=>{ p.targetId=real.id; });
  return {real,fakes,guessers};
}
function beginRound(room){
  if(room.players.filter(p=>p.connected).length < 3) return false;
  room.phase='writing';
  room.round.number += 1;
  room.round.topic=TOPICS[Math.floor(Math.random()*TOPICS.length)];
  room.round.playersAtStart = room.players.filter(p=>p.connected).map(p=>p.id);
  const roles=assignRoles(room);
  room.round.realId=roles.real.id;
  room.round.fakeIds=roles.fakes.map(p=>p.id);
  room.round.guesserIds=roles.guessers.map(p=>p.id);
  room.round.posts={};
  room.round.votes={};
  room.round.voteResults=[];
  room.round.revealed=false;
  room.round.phaseStartedAt=Date.now();
  room.round.writingDeadline=Date.now()+room.settings.writeSeconds*1000;
  room.players.forEach(p=>{ p.currentPost=''; p.lastVote=null; });
  broadcastRound(room);
  return true;
}
function broadcastRound(room){
  const base={ phase:room.phase, number:room.round.number, topic:room.round.topic, settings:room.settings, scoreboard:makeScoreboard(room) };
  room.players.forEach(p=>{
    const payload={...base, role:p.role, self:{id:p.id,name:p.name,anon:p.anon}, roleNames:roleNamesFor(p,room), deadline:room.round.writingDeadline,
      posts:Object.values(room.round.posts).map(post=>({anon:post.anon, text:post.text})),
      candidatePlayers:room.players.filter(x=>x.connected).map(viewerPlayer)
    };
    io.to(p.id).emit('round:update',payload);
  });
}
function roleNamesFor(p,room){
  const real=room.players.find(x=>x.id===room.round.realId);
  const fakes=room.players.filter(x=>room.round.fakeIds.includes(x.id));
  if(p.role==='real' || p.role==='fake') return { realName:real?.name, fakeNames:fakes.map(x=>x.name) };
  return {};
}
function addSuccess(p){ p.correct++; p.attempts++; }
function addFailure(p){ p.attempts++; }
function endRound(room){
  if(room.phase!=='voting') return;
  room.round.revealed=true;
  const realId=room.round.realId;
  const votes=room.round.votes;
  room.round.voteResults = [];
  for(const [voterId,targetId] of Object.entries(votes)){
    const voter=room.players.find(p=>p.id===voterId); if(!voter) continue;
    voter.lastVote=targetId;
    const target=room.players.find(p=>p.id===targetId); if(!target) continue;
    const success=targetId===realId;
    room.round.voteResults.push({voterId, voterName:voter.name, voterAnon:voter.anon, targetId, targetAnon:target.anon, targetName:target.name, success});
    if(voter.role==='guesser'){ success?addSuccess(voter):addFailure(voter); }
  }
  // The real player's own success depends on whether at least one guesser selected them.
  const realChosen = room.round.voteResults.some(v=>v.targetId===realId);
  const real=room.players.find(p=>p.id===realId);
  if(real) realChosen?addSuccess(real):addFailure(real);
  // Every fake that was selected gets success; unselected fakes fail for this round.
  room.round.fakeIds.forEach(fid=>{
    const fake=room.players.find(p=>p.id===fid); if(!fake) return;
    const chosen=room.round.voteResults.some(v=>v.targetId===fid);
    chosen?addSuccess(fake):addFailure(fake);
  });
  room.players.forEach(p=>{
    const base = p.correct/p.attempts*1000;
    p.score=Math.round(base*100)/100;
  });
  room.phase='reveal';
  broadcastReveal(room);
  emitRoom(room);
}
function broadcastReveal(room){
  const base={ phase:'reveal', number:room.round.number, topic:room.round.topic, settings:room.settings, scoreboard:makeScoreboard(room), realId:room.round.realId, fakeIds:room.round.fakeIds,
    posts:Object.values(room.round.posts).map(post=>({id:post.id,anon:post.anon,text:post.text,name:post.name})),
    voteResults:room.round.voteResults, };
  room.players.forEach(p=>{
    io.to(p.id).emit('round:reveal', {...base, realName:room.players.find(x=>x.id===room.round.realId)?.name,
      fakeNames:room.players.filter(x=>room.round.fakeIds.includes(x.id)).map(x=>x.name)});
  });
}
function goVoting(room){
  if(room.phase!=='writing') return;
  room.phase='voting';
  room.round.writingDeadline=0;
  broadcastRound(room);
}

io.on('connection', socket=>{
  socket.on('room:create', ({name, fakeCount, guesserCount, writeSeconds})=>{
    if(!name?.trim()) return socket.emit('error:msg','名前を入力してください');
    let c=code(); while(rooms.has(c)) c=code();
    const p={id:socket.id,name:name.trim().slice(0,20),anon:'A',connected:true,isHost:true,role:'spectator',roleCounts:{real:0,fake:0,guesser:0},correct:0,attempts:0,score:0,currentPost:''};
    const room={code:c,hostId:socket.id,phase:'lobby',settings:{fakeCount:clamp(fakeCount,1,18),guesserCount:clamp(guesserCount,1,18),writeSeconds:clamp(writeSeconds,15,120)},players:[p],round:{number:0},createdAt:Date.now()};
    rooms.set(c,room); socket.join(c);
    socket.emit('room:joined',{code:c,me:publicPlayer(p),players:room.players.map(viewerPlayer),settings:room.settings,isHost:true}); emitRoom(room);
  });
  socket.on('room:join', ({code,name})=>{
    const room=getRoom(String(code||'').trim().toUpperCase());
    if(!room) return socket.emit('error:msg','部屋が見つかりません');
    if(room.phase!=='lobby') return socket.emit('error:msg','この部屋はすでにゲーム中です');
    if(room.players.length>=MAX_PLAYERS) return socket.emit('error:msg','最大20人です');
    if(!name?.trim()) return socket.emit('error:msg','名前を入力してください');
    const p={id:socket.id,name:name.trim().slice(0,20),anon:String.fromCharCode(65+room.players.length),connected:true,isHost:false,role:'spectator',roleCounts:{real:0,fake:0,guesser:0},correct:0,attempts:0,score:0,currentPost:''};
    room.players.push(p); socket.join(room.code);
    socket.emit('room:joined',{code:room.code,me:publicPlayer(p),players:room.players.map(viewerPlayer),settings:room.settings,isHost:false}); emitRoom(room);
  });
  socket.on('room:settings', ({fakeCount,guesserCount,writeSeconds})=>{
    const room=[...rooms.values()].find(r=>r.hostId===socket.id); if(!room) return;
    if(room.phase!=='lobby') return socket.emit('error:msg','開始後は設定を変更できません');
    const connected=room.players.filter(p=>p.connected).length;
    const f=clamp(fakeCount,1,Math.max(1,connected-2));
    const g=clamp(guesserCount,1,Math.max(1,connected-1-f));
    room.settings={fakeCount:f,guesserCount:g,writeSeconds:clamp(writeSeconds,15,120)}; emitRoom(room);
  });
  socket.on('game:start',()=>{
    const room=[...rooms.values()].find(r=>r.hostId===socket.id); if(!room) return;
    const n=room.players.filter(p=>p.connected).length;
    if(n<3){ return socket.emit('error:msg','3人以上必要です'); }
    if(room.settings.fakeCount+room.settings.guesserCount+1>n){ return socket.emit('error:msg','本物・偽物・当てる人の合計が参加人数を超えています'); }
    room.players.forEach(p=>{p.correct=0;p.attempts=0;p.score=0;p.roleCounts={real:0,fake:0,guesser:0};});
    beginRound(room);
  });
  socket.on('post:submit',({text})=>{
    const room=[...rooms.values()].find(r=>r.players.some(p=>p.id===socket.id)); if(!room||room.phase!=='writing') return;
    if(Date.now()>room.round.writingDeadline) return socket.emit('error:msg','投稿時間が終了しました');
    if(room.round.posts[socket.id]) return socket.emit('error:msg','すでに投稿済みです');
    const p=room.players.find(x=>x.id===socket.id); if(!p) return;
    const cleaned=String(text||'').trim().slice(0,200);
    if(!cleaned) return socket.emit('error:msg','文章を入力してください');
    room.round.posts[socket.id]={id:p.id,name:p.name,anon:p.anon,text:cleaned};
    room.round.postCount=Object.keys(room.round.posts).length;
    io.to(room.code).emit('round:postCount',{count:room.round.postCount,total:room.round.playersAtStart.length});
    // During writing, everyone can see the submitted text large; no author mapping is sent.
    io.to(room.code).emit('round:postAdded',{anon:p.anon,text:cleaned});
    if(room.round.postCount>=room.round.playersAtStart.length) goVoting(room);
  });
  socket.on('vote:submit',({targetId})=>{
    const room=[...rooms.values()].find(r=>r.players.some(p=>p.id===socket.id)); if(!room||room.phase!=='voting') return;
    if(!room.round.guesserIds.includes(socket.id)) return socket.emit('error:msg','あなたは当てる人ではありません');
    if(room.round.votes[socket.id]) return socket.emit('error:msg','すでに投票済みです');
    if(!room.round.posts[targetId]) return socket.emit('error:msg','そのプレイヤーは回答候補ではありません');
    room.round.votes[socket.id]=targetId;
    const voter=room.players.find(p=>p.id===socket.id), target=room.players.find(p=>p.id===targetId);
    io.to(room.code).emit('vote:added',{voterId:socket.id,voterName:voter.name,voterAnon:voter.anon,targetId,targetAnon:target.anon});
    const allVoted=room.round.guesserIds.every(id=>room.round.votes[id]); if(allVoted) endRound(room);
  });
  socket.on('game:next',()=>{
    const room=[...rooms.values()].find(r=>r.hostId===socket.id); if(!room) return;
    if(room.phase!=='reveal') return;
    beginRound(room);
  });
  socket.on('game:end',()=>{
    const room=[...rooms.values()].find(r=>r.hostId===socket.id); if(!room) return;
    room.phase='ended';
    room.players.forEach(p=>{p.score=Math.round((p.attempts?p.correct/p.attempts:0)*100000)/100;});
    emitRoom(room);
    io.to(room.code).emit('game:ended',{scoreboard:makeScoreboard(room)});
  });
  socket.on('disconnect',()=>{
    for(const room of rooms.values()){
      const p=room.players.find(x=>x.id===socket.id); if(!p) continue;
      p.connected=false;
      if(room.phase==='lobby'){
        if(room.hostId===socket.id){ const next=room.players.find(x=>x.connected); room.hostId=next?.id||null; if(next) next.isHost=true; }
        emitRoom(room);
      } else {
        io.to(room.code).emit('player:disconnected',{id:socket.id,anon:p.anon});
      }
      break;
    }
  });
});

setInterval(()=>{
  for(const room of rooms.values()){
    if(room.phase==='writing' && Date.now()>room.round.writingDeadline) goVoting(room);
  }
},500);

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'..','public','index.html')));
server.listen(PORT,()=>console.log(`Listening on ${PORT}`));
