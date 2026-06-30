/* ===========================================================================
   Thai Weapon Direction Patch
   Loaded after the game HTML. Graphics-only override.
   Fixes: left-facing melee swing direction, pickaxe icon, bow, pistol, shotgun, rifle.
   =========================================================================== */
(function(){
  "use strict";

  function install(){
    if(typeof ctx==="undefined"||typeof cam==="undefined"||typeof rplayer!=="function"){
      setTimeout(install,80);
      return;
    }
    if(window.__THAI_WEAPON_DIRECTION_PATCH_V1__) return;
    window.__THAI_WEAPON_DIRECTION_PATCH_V1__ = true;

    function T(){ return (typeof now==="function") ? now() : Date.now(); }
    function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
    function hasAny(text,arr){ text=String(text||"").toLowerCase(); for(var i=0;i<arr.length;i++) if(text.indexOf(arr[i])>=0) return true; return false; }
    function rr(x,y,w,h,r){ r=Math.min(r||0,Math.abs(w)/2,Math.abs(h)/2); ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
    function fillRound(x,y,w,h,r,col){ if(col) ctx.fillStyle=col; rr(x,y,w,h,r); ctx.fill(); }
    function line(x1,y1,x2,y2,w,col){ ctx.strokeStyle=col; ctx.lineWidth=w; ctx.lineCap="round"; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); }
    function dot(x,y,r,col){ ctx.fillStyle=col; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); }
    function ellipse(x,y,rx,ry,col,rot){ ctx.fillStyle=col; ctx.beginPath(); ctx.ellipse(x,y,rx,ry,rot||0,0,Math.PI*2); ctx.fill(); }
    function ovalShadow(x,y,rx,ry,a){ ctx.save(); var g=ctx.createRadialGradient(x,y,1,x,y,Math.max(rx,ry)); g.addColorStop(0,"rgba(0,0,0,"+(a==null?.22:a)+")"); g.addColorStop(1,"rgba(0,0,0,0)"); ctx.fillStyle=g; ctx.beginPath(); ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2); ctx.fill(); ctx.restore(); }
    function motion(o){ var vx=o&&o.vx!=null?o.vx:0,vy=o&&o.vy!=null?o.vy:0; if(o&&o.tx!=null&&o.x!=null){ vx=(o.tx-o.x)*10; vy=(o.ty-o.y)*10; } var sp=Math.hypot(vx||0,vy||0); return {vx:vx,vy:vy,speed:sp,moving:sp>5,phase:T()/(sp>80?76:sp>25?105:150)+((o&&o.wob)||0)}; }
    function facing(o,m){ var a=null; if(o&&typeof o.aim==="number") a=o.aim; else if(o&&typeof o.dir==="number") a=o.dir; else if(m&&m.speed>5) a=Math.atan2(m.vy,m.vx); if(a==null||!isFinite(a)) return "down"; var c=Math.cos(a),s=Math.sin(a); if(Math.abs(c)>Math.abs(s)) return c>=0?"right":"left"; return s>=0?"down":"up"; }
    function resourceText(n){ var s=""; if(!n)return s; var keys=["type","kind","id","dropId","drop","item","res","resource","name","nm","t","icon","yield","extra"]; for(var i=0;i<keys.length;i++){ var v=n[keys[i]]; if(v==null) continue; if(typeof v==="string"||typeof v==="number") s+=" "+v; else if(typeof v==="object"){ try{s+=" "+JSON.stringify(v);}catch(e){} } } try{s+=" "+JSON.stringify(n);}catch(e){} return s.toLowerCase(); }
    function isTree(k){ return /tree|wood|log|palm|coconut|mango|ต้นไม้|ไม้ยืนต้น|ไม้/.test(k) && !/bamboo|ไผ่|banana|plantain|กล้วย|ต้นกล้วย/.test(k); }

    function drawThaiTallTree(x,y,s,canopyOnly){ s=s||1; if(!canopyOnly){ ovalShadow(x,y+14*s,20*s,7*s,.16); var tr=ctx.createLinearGradient(x,y-30*s,x,y+18*s); tr.addColorStop(0,"#8f643a"); tr.addColorStop(1,"#5f3f26"); ctx.fillStyle=tr; fillRound(x-7*s,y-10*s,14*s,34*s,4*s); } var sway=Math.sin(T()/900+x*.013)*2*s, balls=[{ox:-18,oy:-36,rx:18,ry:14,c:"#4f974e"},{ox:0,oy:-42,rx:24,ry:17,c:"#5ba756"},{ox:19,oy:-35,rx:18,ry:13,c:"#4c934b"},{ox:-9,oy:-23,rx:21,ry:14,c:"#66b15f"},{ox:13,oy:-21,rx:19,ry:13,c:"#5da858"},{ox:0,oy:-55,rx:18,ry:13,c:"#4e9b50"}]; for(var i=0;i<balls.length;i++){ var p=balls[i]; ctx.fillStyle=p.c; ctx.beginPath(); ctx.ellipse(x+p.ox*s+sway,y+p.oy*s,p.rx*s,p.ry*s,0,0,7); ctx.fill(); } }
    function drawNearbyCanopyOverlay(){ if(typeof G==="undefined"||!G.nodes||!G.player) return; var px=G.player.x,py=G.player.y,drawn=0; for(var i=0;i<G.nodes.length&&drawn<4;i++){ var n=G.nodes[i]; if(!n||n.dead) continue; var k=resourceText(n); if(!isTree(k)) continue; var dx=n.x-px,dy=n.y-py; if(Math.abs(dx)>70||Math.abs(dy)>85) continue; var sx=n.x-cam.x,sy=n.y-cam.y; if(sx<-80||sy<-110||sx>VW+80||sy>VH+80) continue; ctx.save(); ctx.globalAlpha=.82; drawThaiTallTree(sx,sy,1,true); ctx.restore(); drawn++; } }

    function drawNgobHat(x,y,s,lean,face){ s=s||1; lean=lean||0; ctx.save(); ctx.translate(x,y); ctx.rotate(lean); ctx.fillStyle="#d8b56a"; ctx.beginPath(); ctx.ellipse(0,0,face==="side"?11*s:14*s,5*s,0,0,7); ctx.fill(); ctx.fillStyle="#b8873d"; ctx.beginPath(); ctx.moveTo(-8*s,0); ctx.quadraticCurveTo(0,-12*s,8*s,0); ctx.closePath(); ctx.fill(); for(var i=-2;i<=2;i++) line(0,-9*s,i*5*s,0,1*s,"rgba(80,55,28,.35)"); ctx.restore(); }
    function drawPhaKhaoMa(x,y,s,swing,side){ s=s||1; ctx.fillStyle="#b33b35"; ctx.fillRect(x-(side?6:10)*s,y,(side?12:20)*s,5*s); for(var i=side?-4:-8;i<=(side?4:8);i+=4) line(x+i*s,y,x+i*s+swing,y+5*s,1*s,"rgba(242,216,184,.75)"); }

    function drawThaiTool(x,y,ang,id){
      id=String(id||"").toLowerCase();
      var isAxe=hasAny(id,["axe","hatchet","ขวาน"]);
      var isHammer=hasAny(id,["hammer","mallet","club_hammer","ค้อน","ตะลุมพุก"]);
      var isPick=hasAny(id,["pickaxe","pick_axe","pick","stone_pick","stonepick","mining_pick","เสียม","จอบ","ที่ขุดหิน"]);
      var isBow=hasAny(id,["bow","ธนู"]);
      var isPistol=hasAny(id,["pistol","handgun","revolver","ปืนสั้น"]);
      var isShotgun=hasAny(id,["shotgun","ปืนลูกซอง"]);
      var isRifle=hasAny(id,["rifle","longrifle","assault_rifle","ปืนไรเฟิล"]);
      var isSpear=hasAny(id,["spear","หอก"]);
      var isBlade=hasAny(id,["knife","machete","sword","มีด","ดาบ","พร้า"]);
      ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
      if(isBow){ ctx.strokeStyle="#6f4a2b"; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(0,0,11,-Math.PI/2,Math.PI/2); ctx.stroke(); line(0,-11,0,11,1.2,"#d8d6cf"); line(0,0,18,0,2,"#8a6237"); ctx.fillStyle="#cfd6dd"; ctx.beginPath(); ctx.moveTo(18,0); ctx.lineTo(13,-3); ctx.lineTo(13,3); ctx.closePath(); ctx.fill(); }
      else if(isPistol){ fillRound(0,-3,14,6,2,"#44484d"); fillRound(11,-2,5,4,1,"#5c6166"); fillRound(4,2,4,7,1.5,"#6b4a2a"); fillRound(1,-2,3,3,1,"#5b6064"); }
      else if(isShotgun){ line(-8,0,10,0,3.2,"#6f4a2b"); fillRound(9,-2,18,4,1.5,"#71767b"); fillRound(-2,-3,7,6,2,"#4a4f54"); fillRound(-7,1,5,7,1.5,"#6f4a2b"); }
      else if(isRifle){ line(-10,0,7,0,3.2,"#6f4a2b"); fillRound(6,-2,22,4,1.5,"#6f757b"); fillRound(0,-3,9,6,2,"#4a4f54"); fillRound(-5,1,4,8,1.2,"#6f4a2b"); fillRound(11,-5,4,2,1,"#5a6066"); }
      else { line(-6,0,15,0,3.2,"#7a5331"); if(isAxe){ ctx.fillStyle="#c7d0d8"; ctx.beginPath(); ctx.moveTo(9,-7); ctx.lineTo(21,-4); ctx.lineTo(14,1); ctx.lineTo(21,5); ctx.lineTo(9,7); ctx.lineTo(6,0); ctx.closePath(); ctx.fill(); }
        else if(isHammer){ fillRound(8,-5,13,10,2,"#8e9398"); fillRound(6,-2,4,4,1,"#6b6f73"); ctx.fillStyle="#aeb4ba"; ctx.fillRect(18,-2,5,4); }
        else if(isPick){ line(8,0,18,0,3.2,"#7b8288"); line(10,-6,19,0,3,"#c8d0d7"); line(10,6,19,0,3,"#c8d0d7"); }
        else if(isSpear){ ctx.fillStyle="#d8d8cf"; ctx.beginPath(); ctx.moveTo(13,-5); ctx.quadraticCurveTo(24,-1,13,6); ctx.closePath(); ctx.fill(); }
        else if(isBlade){ ctx.fillStyle="#d9dbd6"; ctx.beginPath(); ctx.moveTo(10,-4); ctx.lineTo(23,-1); ctx.lineTo(12,5); ctx.lineTo(8,3); ctx.closePath(); ctx.fill(); } }
      ctx.restore();
    }

    function drawThaiHuman(e,sx,sy,opt){
      opt=opt||{}; var m=motion(e||{}), f=facing(e||{},m), side=f==="left"||f==="right", up=f==="up", dirMul=f==="left"?-1:1;
      var ph=m.phase, walk=m.moving?Math.sin(ph):Math.sin(ph*.45)*.12, walkOpp=m.moving?Math.sin(ph+Math.PI):Math.sin(ph*.45+Math.PI)*.12;
      var bob=m.moving?Math.abs(Math.sin(ph))*1.35:Math.abs(Math.sin(ph*.65))*.45;
      var hurt=clamp(Math.max((e&&e.hitT)||0,(e&&e.dmgT)||0),0,1), atk=clamp(((e&&e.atkT)||0)/.24,0,1), pAtk=atk>0?1-atk:0, swing=atk?Math.sin(pAtk*Math.PI):0;
      var weapon=opt.weapon||"", wid=String(weapon||"").toLowerCase();
      var isBowWeapon=hasAny(wid,["bow","ธนู"]), isGunWeapon=hasAny(wid,["pistol","handgun","revolver","ปืนสั้น","shotgun","ปืนลูกซอง","rifle","longrifle","assault_rifle","ปืนไรเฟิล"]);
      var heavy=hasAny(wid,["axe","hatchet","ขวาน","hammer","mallet","ค้อน","pickaxe","pick_axe","pick","stone_pick","stonepick","mining_pick","เสียม","จอบ","ที่ขุดหิน"]);
      var raise=heavy?swing*2.2:swing*1.5, drop=heavy?pAtk*15:pAtk*10;
      var carry=!!(e&&(e.carrying||(typeof G!=="undefined"&&G.beacon&&G.beacon.state==="carried"&&e===G.player)));
      var y=sy-bob+hurt*1.3, skin=opt.skin||"#efc79d", shirt=opt.shirt||"#294d61", pant=opt.pant||"#2b2a28", lean=side?dirMul*.08:clamp(m.vx/120,-.12,.12);
      ovalShadow(sx,sy+12,side?10:12,5.5,.24); if(m.moving&&Math.abs(Math.sin(ph))>.95){ctx.globalAlpha=.22; ellipse(sx-dirMul*7,sy+21,5,2,"#c18b55"); ctx.globalAlpha=1;}
      if(side){ line(sx-2,y+8,sx-3+dirMul*walk*2.5,y+22+Math.max(0,walkOpp)*1.5,5,pant); line(sx+3,y+8,sx+2-dirMul*walk*2.5,y+22+Math.max(0,walk)*1.5,5,pant); fillRound(sx-7,y+20,14,4,2,"#221b15"); }
      else { line(sx-5,y+8,sx-7+walk*3.5,y+22-Math.max(0,walk)*2,5,pant); line(sx+5,y+8,sx+7+walkOpp*3.5,y+22-Math.max(0,walkOpp)*2,5,pant); fillRound(sx-10,y+20,8,4,2,"#221b15"); fillRound(sx+2,y+20,8,4,2,"#221b15"); }
      ctx.save(); ctx.translate(sx,y); ctx.rotate(lean); var g=ctx.createLinearGradient(0,-10,0,13); g.addColorStop(0,up?"#345467":"#3f6475"); g.addColorStop(1,shirt); ctx.fillStyle=g; fillRound(side?-8:-11,-7,side?16:22,22,8); drawPhaKhaoMa(0,5,1,m.moving?Math.sin(ph)*.8:0,side); fillRound(-3,-12,6,5,2,skin); var gh=ctx.createRadialGradient(-3,-16,1,0,-14,10); gh.addColorStop(0,"#f8ddb8"); gh.addColorStop(1,skin); ctx.fillStyle=gh; ctx.beginPath(); ctx.arc(0,-14,9,0,7); ctx.fill(); if(up){ctx.fillStyle="#211813";ctx.beginPath();ctx.arc(0,-16,8,Math.PI,Math.PI*2);ctx.lineTo(8,-12);ctx.lineTo(-8,-12);ctx.closePath();ctx.fill();} else if(side){dot(3*dirMul,-15,1.35,"#241911");line(3*dirMul,-10.5,7*dirMul,-10.2,1.1,"rgba(120,55,42,.7)");} else {dot(-2.4,-15,1.2,"#241911");dot(2.5,-15,1.2,"#241911");line(-1,-10.5,3,-10.3,1.1,"rgba(120,55,42,.7)");} drawNgobHat(0,-23,opt.hatScale||1,-lean*.5,side?"side":"front"); ctx.restore();
      if(up){ line(sx-7,y-1,sx-13-walk*3,y+8,4,skin); line(sx+7,y-1,sx+13+walk*3,y+8,4,skin); }
      else if(side){ line(sx-3*dirMul,y-1,sx-10*dirMul-walk*2,y+8,4,skin); }
      else { line(sx-7,y-1,sx-14-walk*4,y+8,4,skin); }
      if(side){ var shoulderX=sx+4*dirMul, shoulderY=y-2, handX, handY, toolAng; if(isBowWeapon||isGunWeapon){ handX=sx+13*dirMul; handY=y+1; line(shoulderX,shoulderY,handX,handY,4.2,skin); if(weapon){ toolAng=dirMul>0?.02:Math.PI-.02; drawThaiTool(handX,handY,toolAng,weapon); } } else { handX=sx+(8+raise*4)*dirMul; handY=y+5-raise*7+drop; if(atk>0){ handX=sx+(10+raise*7)*dirMul; handY=y-8-raise*6+drop*1.05; } line(shoulderX,shoulderY,handX,handY,4.2,skin); if(weapon){ toolAng=dirMul>0 ? (atk>0?(-1.25+pAtk*1.75):.18) : (atk>0?(Math.PI+1.25-pAtk*1.75):(Math.PI-.18)); drawThaiTool(handX,handY,toolAng,weapon); } } }
      else { var fx=sx+14+walkOpp*2, fy=y+8; if(isBowWeapon||isGunWeapon){ fx=sx+12; fy=y+2; line(sx+7,y-1,fx,fy,4,skin); if(weapon) drawThaiTool(fx,fy,.06,weapon); } else { if(atk>0){fx=sx+10+raise*4; fy=y-2-raise*4+drop*.7;} line(sx+7,y-1,fx,fy,4,skin); if(weapon){ var toolAng2=atk>0?(-.95+pAtk*1.35):.18; drawThaiTool(fx,fy,toolAng2,weapon); } } }
      if(carry){ fillRound(sx-9,y-36,18,12,4,"#8b5d36"); line(sx-6,y-33,sx+6,y-33,2,"#d4af37"); }
    }

    var oldRPlayer = rplayer, oldRBot = rbot;
    rplayer=function(sx,sy){ var p=G.player||{}; var weapon=G.equip&&G.equip.hand?G.equip.hand.id:""; drawThaiHuman(p,sx,sy,{shirt:"#294d61",pant:"#2b2a28",weapon:weapon,hatScale:1}); drawNearbyCanopyOverlay(); };
    rbot=function(o,sx,sy){ drawThaiHuman(o||{},sx,sy,{shirt:"#3e5f43",pant:"#342a23",weapon:"",skin:"#e3b184",hatScale:.86}); dot(sx,sy-30,2.1,"rgba(255,255,255,.72)"); };
    if(typeof toast==="function") setTimeout(function(){ toast("🏹 เพิ่มธนู/ปืน และแก้ฟาดซ้าย+ที่ขุดหินแล้ว"); },900);
  }
  setTimeout(install,0);
})();
