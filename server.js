const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const root = __dirname;
const server = http.createServer((req,res)=>{
  let p = decodeURIComponent((req.url||'/').split('?')[0]); if(p==='/' ) p='/index.html';
  const file=path.join(root,p.replace(/^\/+/,''));
  if(!file.startsWith(root)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found');}
    const type=file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream';
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);
  });
});
const wss=new WebSocket.Server({server});
const rooms=new Map();
const costs={factory:200,aa:200,mog:100,launch:300,psd:200};
function makeRoom(code){return {code,players:[],state:{tick:0,started:false,winner:null,players:[0,1].map((id)=>({id,money:100,baseHp:100,buildings:[],drones:[],rocketCooldown:0,droneCooldown:0,psd:0,launch:0}))}}}
function send(ws,obj){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}
function broadcast(room,obj){for(const p of room.players)send(p.ws,obj)}
function snap(room){return {type:'state',state:room.state,players:room.players.map(p=>({id:p.id,name:p.name,connected:p.ws.readyState===WebSocket.OPEN}))}}
function resetRoom(room){room.state=makeRoom(room.code).state;room.players.forEach((p,i)=>p.id=i);}
wss.on('connection',ws=>{
 let room=null, player=null;
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}
  if(m.type==='join'){
    const code=String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8)||Math.random().toString(36).slice(2,6).toUpperCase();
    if(!rooms.has(code))rooms.set(code,makeRoom(code)); room=rooms.get(code);
    if(room.players.length>=2){send(ws,{type:'error',message:'Комната уже заполнена. Создай новую или введи другой код.'});return;}
    player={ws,id:room.players.length,name:String(m.name||('Игрок '+(room.players.length+1))).slice(0,18)};room.players.push(player);
    if(room.players.length===2)room.state.started=true;
    send(ws,{type:'joined',code,id:player.id});broadcast(room,snap(room));return;
  }
  if(!room||!player)return;
  if(m.type==='restart'&&room.players.length===2){resetRoom(room);room.state.started=true;broadcast(room,snap(room));return;}
  if(m.type==='build'){
    if(!room.state.started||room.state.winner!==null)return;
    const me=room.state.players[player.id],type=m.build;
    if(!Object.hasOwn(costs,type)||me.money<costs[type])return;
    const max={mog:5,psd:4,launch:3,factory:4};if(max[type]&&me.buildings.filter(b=>b.type===type).length>=max[type])return;
    const x=Math.max(0,Math.min(1000,Number(m.x)||0)), y=Math.max(0,Math.min(560,Number(m.y)||0));
    // Keep structures on their owner's half and away from the base.
    if(player.id===0&&x>480||player.id===1&&x<520)return;
    me.money-=costs[type];me.buildings.push({id:Date.now()+Math.random(),type,x,y,hp:type==='factory'?30:20});
    if(type==='psd')me.psd++;if(type==='launch')me.launch++;
    broadcast(room,snap(room));return;
  }
  if(m.type==='launchDrone'||m.type==='launchRocket'){
    if(!room.state.started||room.state.winner!==null)return;
    const me=room.state.players[player.id],enemy=room.state.players[1-player.id];
    if(m.type==='launchDrone'){
      const cost=Math.max(5,10-me.launch);if(me.money<cost||me.droneCooldown>0)return;me.money-=cost;me.droneCooldown=Math.max(1,5-me.psd);
      me.drones.push({id:Math.random(),kind:'drone',x:player.id===0?110:890,y:280,target:1-player.id,hp:1,speed:2.2});
    } else {
      const cost=Math.max(50,100-me.launch*5);if(me.money<cost||me.rocketCooldown>0)return;me.money-=cost;me.rocketCooldown=18;
      me.drones.push({id:Math.random(),kind:'rocket',x:player.id===0?110:890,y:280,target:1-player.id,hp:1,speed:3.3});
    }
    broadcast(room,snap(room));return;
  }
 });
 ws.on('close',()=>{if(!room||!player)return;room.players=room.players.filter(p=>p!==player);if(room.players.length===0)rooms.delete(room.code);else broadcast(room,{type:'opponentLeft',message:'Соперник отключился.'});});
});
setInterval(()=>{for(const room of rooms.values()){
 const s=room.state;if(!s.started||s.winner!==null)continue;s.tick++;
 for(const p of s.players){if(s.tick%300===0)p.money+=100;for(const b of p.buildings)if(b.type==='factory'&&s.tick%300===0)p.money+=50;p.droneCooldown=Math.max(0,p.droneCooldown-1/30);p.rocketCooldown=Math.max(0,p.rocketCooldown-1/30);}
 for(const p of s.players){for(const d of [...p.drones]){const target=s.players[d.target];const tx=d.target===0?110:890,ty=280;const dx=tx-d.x,dy=ty-d.y,dist=Math.hypot(dx,dy)||1;d.x+=dx/dist*d.speed;d.y+=dy/dist*d.speed;
   if(dist<16){if(d.kind==='rocket')target.baseHp-=28;else target.baseHp-=8;p.drones=p.drones.filter(x=>x!==d);if(target.baseHp<=0){target.baseHp=0;s.winner=p.id;}}
   // prototype AA/MOG defense: nearby defensive structures probabilistically intercept drones
   if(d.kind==='drone'){let shot=false;for(const def of target.buildings.filter(b=>b.type==='aa'||b.type==='mog')){if(Math.hypot(def.x-d.x,def.y-d.y)<115&&Math.random()<0.012){p.drones=p.drones.filter(x=>x!==d);shot=true;break;}}if(shot)continue;}
  }}
 if(s.tick%3===0)broadcast(room,snap(room));
 }} ,1000/30);
server.listen(PORT,()=>console.log(`Terra Nova multiplayer running on port ${PORT}`));
