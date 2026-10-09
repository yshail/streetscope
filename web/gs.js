/* Streetscope gaussian splat renderer (WebGL2), no dependencies.

   This is real 3D Gaussian Splatting rendering: every splat is an anisotropic 3D gaussian (position, scale, rotation,
   colour, opacity). Each frame its 3D covariance is projected to the screen with the EWA Jacobian, splats are sorted
   back to front in a worker, and blended with premultiplied alpha, the same way 3DGS viewers draw trained scenes.

   Where the splats come from:
   - GS.fromTwin(twin)      generated from the open-data twin (ground, road markings, facades, roofs, tree crowns).
                            Real renderer, but the gaussians are made from map data, not trained from photos.
   - GS.parsePly / parseSplat  a real captured scene (3DGS .ply or .splat), e.g. one trained in LichtFeld or gsplat.
   GS.toSplat writes the current scene as a standard .splat file for SuperSplat and other viewers.

   Loading effect: splats rise from below as small glowing particles in a wave from the centre, then settle and
   grow to full size, in the style of Luma's reveal. */
(function(){
'use strict';
const GS={};

/* ---------- small maths ---------- */
const _f=new Float32Array(1), _u=new Uint32Array(_f.buffer);
function toHalf(v){_f[0]=v;const x=_u[0],s=(x>>>16)&0x8000,e=((x>>>23)&0xff)-112,m=x&0x7fffff;
  if(e<=0){if(e<-10)return s;return s+(((m|0x800000)>>>(1-e))+0x1000>>>13)}
  if(e>=31)return s|0x7c00; return s+(e<<10)+((m+0x1000)>>>13)}
function quatFromAxes(a1,a2,a3){ // rotation whose columns are a1,a2,a3 -> [w,x,y,z]
  const m00=a1[0],m10=a1[1],m20=a1[2],m01=a2[0],m11=a2[1],m21=a2[2],m02=a3[0],m12=a3[1],m22=a3[2],tr=m00+m11+m22;let S;
  if(tr>0){S=Math.sqrt(tr+1)*2;return[.25*S,(m21-m12)/S,(m02-m20)/S,(m10-m01)/S]}
  if(m00>m11&&m00>m22){S=Math.sqrt(1+m00-m11-m22)*2;return[(m21-m12)/S,.25*S,(m01+m10)/S,(m02+m20)/S]}
  if(m11>m22){S=Math.sqrt(1+m11-m00-m22)*2;return[(m02-m20)/S,(m01+m10)/S,.25*S,(m12+m21)/S]}
  S=Math.sqrt(1+m22-m00-m11)*2;return[(m10-m01)/S,(m02+m20)/S,(m12+m21)/S,.25*S]}
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l]};
function qmul(a,b){return[a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]]}
function octEnc(nx,ny,nz){const l=Math.abs(nx)+Math.abs(ny)+Math.abs(nz)||1;let u=nx/l,v=nz/l;
  if(ny<0){const ou=u;u=(1-Math.abs(v))*(ou>=0?1:-1);v=(1-Math.abs(ou))*(v>=0?1:-1)}
  return (Math.round((u*.5+.5)*255))|(Math.round((v*.5+.5)*255)<<8)}
function rng(seed){let s=(seed>>>0)||1;return()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return(s>>>0)/4294967296}}
function hash2(x,z){let h=(Math.imul(x|0,374761393)+Math.imul(z|0,668265263))|0;h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967296}
function vnoise(x,z){const xi=Math.floor(x),zi=Math.floor(z),fx=x-xi,fz=z-zi,sx=fx*fx*(3-2*fx),sz=fz*fz*(3-2*fz);
  const a=hash2(xi,zi),b=hash2(xi+1,zi),c=hash2(xi,zi+1),d=hash2(xi+1,zi+1);return a+(b-a)*sx+(c-a)*sz+(a-b-c+d)*sx*sz}
const hex=h=>[(h>>16)&255,(h>>8)&255,h&255];

/* ---------- splat store ---------- */
function Store(cap){this.n=0;this.grow(cap||65536)}
Store.prototype.grow=function(c){const P=new Float32Array(c*3),S=new Float32Array(c*3),Q=new Float32Array(c*4),C=new Uint8Array(c*4),M=new Uint32Array(c);
  if(this.pos){P.set(this.pos);S.set(this.scale);Q.set(this.rot);C.set(this.col);M.set(this.meta)}
  this.pos=P;this.scale=S;this.rot=Q;this.col=C;this.meta=M;this.cap=c};
// meta bits: 0-15 normal (octahedral), 16-19 type (0 capture, 1 ground, 2 lit surface, 3 foliage, 5 planned foliage), 24-31 random
Store.prototype.add=function(x,y,z,s1,s2,s3,q,rgb,a,nrm,type,rnd){
  if(this.n>=this.cap)this.grow(this.cap*2);const i=this.n++,i3=i*3,i4=i*4;
  this.pos[i3]=x;this.pos[i3+1]=y;this.pos[i3+2]=z;this.scale[i3]=s1;this.scale[i3+1]=s2;this.scale[i3+2]=s3;
  this.rot[i4]=q[0];this.rot[i4+1]=q[1];this.rot[i4+2]=q[2];this.rot[i4+3]=q[3];
  this.col[i4]=rgb[0]<0?0:rgb[0]>255?255:rgb[0];this.col[i4+1]=rgb[1]<0?0:rgb[1]>255?255:rgb[1];this.col[i4+2]=rgb[2]<0?0:rgb[2]>255?255:rgb[2];this.col[i4+3]=a;
  this.meta[i]=(nrm&0xffff)|((type&15)<<16)|((Math.floor(rnd*255)&255)<<24)};
Store.prototype.done=function(extra){const n=this.n;return Object.assign({n:n,pos:this.pos.subarray(0,n*3),scale:this.scale.subarray(0,n*3),rot:this.rot.subarray(0,n*4),col:this.col.subarray(0,n*4),meta:this.meta.subarray(0,n)},extra||{})};

/* ---------- gaussians from the open-data twin ---------- */
const FACADE=[0xc9b9a1,0xb8a99a,0xd8cbb5,0xa89586,0xc7c2b8,0xb0a28d,0xd0c4ae,0x9f9488], ROOF=[0x9a9690,0x8c8a86,0xa8a29a,0x7d7f83,0x96918a];
const ASPHALT={main:0x3a3d42,mid:0x414449,local:0x4b4e53}, PAVING=0xb9b2a5, GRASS=0x6c7d52, EARTH=0x8a7a5c;
GS.fromTwin=function(T,opt){
  opt=opt||{}; const R=T.meta.radius_m, H=R*1.15, rand=rng(opt.seed||7), st=new Store(1<<19), up=[0,1,0];
  const jit=(c,k)=>{const f=1+(rand()-.5)*k;return[c[0]*f,c[1]*f,c[2]*f]};
  const nUp=octEnc(0,1,0);
  // 1. rasterise roads and footprints so each ground splat knows what it sits on
  const res=1, N=Math.ceil(2*H/res), cv=document.createElement('canvas'); cv.width=cv.height=N; const g=cv.getContext('2d');
  const P=(x,z)=>[(x+H)/res,(z+H)/res], CODE={local:60,mid:100,main:140,walk:200};
  g.lineCap='round';g.lineJoin='round';
  ['local','mid','main','walk'].forEach(cls=>{g.strokeStyle='rgb('+CODE[cls]+',0,0)';
    T.roads.forEach(r=>{if(r.cls!==cls||r.pts.length<2||r.bridge)return;g.lineWidth=Math.max(1,r.width_m/res);g.beginPath();r.pts.forEach((p,i)=>{const q=P(p[0],p[1]);i?g.lineTo(q[0],q[1]):g.moveTo(q[0],q[1])});g.stroke()})});
  g.fillStyle='rgb(250,0,0)';T.buildings.forEach(b=>{g.beginPath();b.footprint.forEach((p,i)=>{const q=P(p[0],p[1]);i?g.lineTo(q[0],q[1]):g.moveTo(q[0],q[1])});g.closePath();g.fill()});
  const px=g.getImageData(0,0,N,N).data;
  const classAt=(x,z)=>{const i=Math.floor((x+H)/res),j=Math.floor((z+H)/res);if(i<0||j<0||i>=N||j>=N)return 0;const v=px[(j*N+i)*4];return v>225?250:v>170?200:v>120?140:v>80?100:v>35?60:0};
  // 2. ground: flat discs on a jittered grid
  const gs=Math.max(.9,Math.sqrt(4*H*H/190000));
  for(let x=-H;x<H;x+=gs)for(let z=-H;z<H;z+=gs){
    const jx=x+rand()*gs,jz=z+rand()*gs,d=Math.hypot(jx,jz);if(d>R*1.12)continue;
    const c=classAt(jx,jz);if(c===250)continue;
    let col;
    if(c===200)col=jit(hex(PAVING),.08);
    else if(c>=60){col=jit(hex(c===140?ASPHALT.main:c===100?ASPHALT.mid:ASPHALT.local),.06);const k=.9+.2*vnoise(jx*.3,jz*.3);col=[col[0]*k,col[1]*k,col[2]*k]}
    else{const t=vnoise(jx*.035,jz*.035),u=vnoise(jx*.2+50,jz*.2);const a=hex(GRASS),b=hex(EARTH);col=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t].map(v=>v*(.85+.3*u))}
    const th=rand()*Math.PI,a1=[Math.cos(th),0,Math.sin(th)],a2=[-Math.sin(th),0,Math.cos(th)];
    st.add(jx,.0,jz,gs*.72*(.8+.4*rand()),gs*.6*(.8+.4*rand()),.02,quatFromAxes(a1,a2,cross(a1,a2)),col,255,nUp,1,rand());
  }
  // 3. road markings: dashed centre lines and solid edge lines on main and secondary roads, zebra stripes at crossings
  const white=[232,232,226], line=(x,z,dx,dz,len,wid,col)=>{const a1=[dx,0,dz],a2=[-dz,0,dx];st.add(x,.03,z,len,wid,.015,quatFromAxes(a1,a2,cross(a1,a2)),jit(col,.05),245,nUp,1,rand())};
  T.roads.forEach(r=>{if((r.cls!=='main'&&r.cls!=='mid')||r.pts.length<2||r.bridge)return;let run=0;
    for(let i=1;i<r.pts.length;i++){const a=r.pts[i-1],b=r.pts[i],L=Math.hypot(b[0]-a[0],b[1]-a[1]);if(L<.5)continue;const dx=(b[0]-a[0])/L,dz=(b[1]-a[1])/L,nx=-dz,nz=dx,hw=r.width_m/2-.35;
      for(let s=0;s<L;s+=1.2){const x=a[0]+dx*s,z=a[1]+dz*s;if(Math.hypot(x,z)>R*1.1)continue;
        if(r.cls==='main'){line(x+nx*hw,z+nz*hw,dx,dz,.75,.07,white);line(x-nx*hw,z-nz*hw,dx,dz,.75,.07,white)}
        if(!r.oneway&&((run+s)%9)<3)line(x,z,dx,dz,.7,.07,r.cls==='main'?[230,200,90]:white)}
      run+=L}});
  const roadDir=(x,z)=>{let best=null,bd=14;T.roads.forEach(r=>{if(r.cls==='walk')return;for(let i=1;i<r.pts.length;i++){const a=r.pts[i-1],b=r.pts[i],ex=b[0]-a[0],ez=b[1]-a[1],L2=ex*ex+ez*ez||1,t=Math.max(0,Math.min(1,((x-a[0])*ex+(z-a[1])*ez)/L2)),d=Math.hypot(a[0]+ex*t-x,a[1]+ez*t-z);if(d<bd){bd=d;const L=Math.sqrt(L2);best={dx:ex/L,dz:ez/L,w:r.width_m}}}});return best};
  (T.crossings||[]).forEach(c=>{const rd=roadDir(c.x,c.z);if(!rd)return;const nx=-rd.dz,nz=rd.dx;
    for(let k=-rd.w/2+.6;k<rd.w/2-.4;k+=1.0){const x=c.x+nx*k,z=c.z+nz*k;line(x+rd.dx*.7,z+rd.dz*.7,rd.dx,rd.dz,.75,.2,white);line(x-rd.dx*.7,z-rd.dz*.7,rd.dx,rd.dz,.75,.2,white)}});
  // 4. buildings: flat gaussians lying in each wall and roof, with floors, windows and storefronts
  let area=0;T.buildings.forEach(b=>{const f=b.footprint;let per=0,ar=0;for(let i=0;i<f.length;i++){const a=f[i],c=f[(i+1)%f.length];per+=Math.hypot(c[0]-a[0],c[1]-a[1]);ar+=a[0]*c[1]-c[0]*a[1]}area+=per*b.height_m+Math.abs(ar)/2});
  const sw=Math.max(.7,Math.sqrt(area/300000));
  function wallsAndRoof(f,h,wallHex,roofHex,glass,bi,y0){
    y0=y0||0; let cx=0,cz=0;f.forEach(p=>{cx+=p[0]/f.length;cz+=p[1]/f.length});
    const wall=hex(wallHex),win=glass?[78,96,114]:[58,68,80],shop=[70,82,92];
    for(let i=0;i<f.length;i++){const a=f[i],c=f[(i+1)%f.length],ex=c[0]-a[0],ez=c[1]-a[1],L=Math.hypot(ex,ez);if(L<.4)continue;
      let nx=ez/L,nz=-ex/L;if(nx*((a[0]+c[0])/2-cx)+nz*((a[1]+c[1])/2-cz)<0){nx=-nx;nz=-nz}
      const a1=[ex/L,0,ez/L],q=quatFromAxes(a1,up,cross(a1,up)),nm=octEnc(nx,0,nz),nu=Math.max(1,Math.round(L/sw)),nv=Math.max(1,Math.round((h-y0)/sw));
      for(let u=0;u<nu;u++)for(let v=0;v<nv;v++){
        const t=(u+.5+(rand()-.5)*.3)/nu,y=y0+(v+.5+(rand()-.5)*.3)/nv*(h-y0),s=t*L,fl=y%3.2;let col;
        if(glass){const mull=(s%1.6)<.25||fl<.3;const sky=.85+.35*(y/Math.max(h,1));col=mull?[150,160,170]:[win[0]*sky,win[1]*sky,win[2]*sky*1.1]}
        else if(y<3.6&&h>7)col=((s%4.2)<3.2&&y>.4&&y<3.0)?jit(shop,.1):jit(wall,.08);
        else col=(fl>1.0&&fl<2.4&&(s%2.6)>.7&&(s%2.6)<2.1)?jit(win,.12):jit(wall,.07);
        if(y<1.2)col=col.map(v=>v*.82);
        st.add(a[0]+ex*t+nx*.04,y,a[1]+ez*t+nz*.04,sw*.62,sw*.62,.03,q,col,255,nm,2,rand())}}
    let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9;f.forEach(p=>{x0=Math.min(x0,p[0]);x1=Math.max(x1,p[0]);z0=Math.min(z0,p[1]);z1=Math.max(z1,p[1])});
    const roof=hex(roofHex),rs=sw*1.05,qr=quatFromAxes([1,0,0],[0,0,1],[0,-1,0]);
    for(let x=x0+rs/2;x<x1;x+=rs)for(let z=z0+rs/2;z<z1;z+=rs){const jx=x+(rand()-.5)*rs*.3,jz=z+(rand()-.5)*rs*.3;
      if(inPoly(jx,jz,f))st.add(jx,h+.02,jz,rs*.65,rs*.65,.03,qr,jit(roof,.1).map(v=>v*(.9+.2*vnoise(jx*.4+bi,jz*.4))),255,nUp,2,rand())}
    return (x1-x0)*(z1-z0);
  }
  T.buildings.forEach((b,bi)=>{const r=hash2(bi,17),h=b.height_m,glass=h>38&&r<.7;
    const ra=wallsAndRoof(b.footprint,h,FACADE[Math.floor(r*FACADE.length)],ROOF[Math.floor(hash2(bi,5)*ROOF.length)],glass,bi);
    if(ra>500&&h>6){let cx=0,cz=0;b.footprint.forEach(p=>{cx+=p[0]/b.footprint.length;cz+=p[1]/b.footprint.length});   // a rooftop plant room
      const w=2+hash2(bi,9)*3,d=2+hash2(bi,11)*2,ox=(hash2(bi,13)-.5)*4,oz=(hash2(bi,15)-.5)*4;
      if(inPoly(cx+ox,cz+oz,b.footprint))wallsAndRoof([[cx+ox-w,cz+oz-d],[cx+ox+w,cz+oz-d],[cx+ox+w,cz+oz+d],[cx+ox-w,cz+oz+d]],h+2.6,0x9c9a94,0x7f7d78,false,bi,h)}});
  (T.stops||[]).forEach((s,i)=>wallsAndRoof([[s.x-1.6,s.z-.7],[s.x+1.6,s.z-.7],[s.x+1.6,s.z+.7],[s.x-1.6,s.z+.7]],2.6,0x5b7fb5,0x3e5f8f,false,i,0));
  // 5. trees: a crown of small leaf-like gaussians, darker inside and underneath, plus a trunk
  const addTree=(t,type)=>{const cy=t.height_m-t.crown_r*.85,cr=t.crown_r,n=Math.round(Math.max(40,Math.min(420,cr*cr*26)));
    const base=type===5?[150,200,80]:(t.source==='osm'?[52,112,64]:[78,138,72]),tint=.85+.3*hash2(Math.round(t.x*7),Math.round(t.z*7));
    for(let i=0;i<n;i++){const u=rand()*2-1,ph=rand()*6.2832,s=Math.sqrt(1-u*u),rr=Math.cbrt(.25+.75*rand()),nx=s*Math.cos(ph),nz=s*Math.sin(ph);
      const ao=.55+.35*rr+.2*u,col=[base[0]*tint*ao*(.85+.3*rand()),base[1]*tint*ao*(.85+.3*rand()),base[2]*tint*ao*(.8+.3*rand())];
      const a1=norm([rand()-.5,rand()-.5,rand()-.5]),a2=norm(cross(a1,[rand()-.5,rand()-.5,rand()-.5]));
      st.add(t.x+nx*cr*rr,cy+u*cr*.85*rr,t.z+nz*cr*rr,cr*(.13+.12*rand()),cr*(.09+.08*rand()),cr*.03,quatFromAxes(a1,a2,cross(a1,a2)),col,235,octEnc(nx,u,nz),type,rand())}
    const qt=quatFromAxes([0,1,0],[0,0,1],[1,0,0]);
    for(let y=.4;y<cy;y+=.8)st.add(t.x,y,t.z,.5,.14,.14,qt,jit([98,82,64],.1),255,octEnc(1,0,0),type===5?5:2,rand())};
  T.trees.forEach(t=>addTree(t,3)); (opt.planned||[]).forEach(t=>addTree(t,5));
  return st.done({radius:R,source:'twin'});
};
function inPoly(x,z,f){let c=false;for(let i=0,j=f.length-1;i<f.length;j=i++){const a=f[i],b=f[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])c=!c}return c}

/* ---------- real captures: 3DGS .ply and .splat ---------- */
GS.parsePly=function(buf){
  const head=new TextDecoder().decode(new Uint8Array(buf,0,Math.min(buf.byteLength,65536))),end=head.indexOf('end_header');
  if(end<0)throw new Error('not a PLY file');
  if(head.indexOf('binary_little_endian')<0)throw new Error('only binary little-endian PLY is supported');
  const lines=head.slice(0,end).split(/\r?\n/);let n=0,inV=false;const props=[];const SZ={float:4,float32:4,double:8,uchar:1,uint8:1,char:1,int8:1,short:2,int16:2,ushort:2,uint16:2,int:4,int32:4,uint:4,uint32:4};
  for(const l of lines){const w=l.trim().split(/\s+/);if(w[0]==='element'){inV=w[1]==='vertex';if(inV)n=+w[2]}else if(w[0]==='property'&&inV)props.push({t:w[1],name:w[2]})}
  let off=0;const at={};props.forEach(p=>{at[p.name]={o:off,t:p.t};off+=SZ[p.t]||4});
  if(!at.x||!at.scale_0||!at.rot_0)throw new Error('this PLY has no gaussian fields (scale_0, rot_0). Compressed PLY is not supported yet.');
  const start=head.indexOf('\n',end)+1,dv=new DataView(buf,start),stride=off,st=new Store(n),SH=.28209479177387814;
  const rd=(i,k)=>{const a=at[k];return a?(a.t==='double'?dv.getFloat64(i*stride+a.o,true):dv.getFloat32(i*stride+a.o,true)):0};
  for(let i=0;i<n;i++){
    const q=norm4([rd(i,'rot_0'),rd(i,'rot_1'),rd(i,'rot_2'),rd(i,'rot_3')]),op=1/(1+Math.exp(-rd(i,'opacity')));
    const col=at.f_dc_0?[(.5+SH*rd(i,'f_dc_0'))*255,(.5+SH*rd(i,'f_dc_1'))*255,(.5+SH*rd(i,'f_dc_2'))*255]:[rd(i,'red'),rd(i,'green'),rd(i,'blue')];
    st.add(rd(i,'x'),rd(i,'y'),rd(i,'z'),Math.exp(rd(i,'scale_0')),Math.exp(rd(i,'scale_1')),Math.exp(rd(i,'scale_2')),q,col.map(Math.round),Math.round(op*255),0,0,Math.random())}
  return st.done({source:'capture'});
};
function norm4(q){const l=Math.hypot(q[0],q[1],q[2],q[3])||1;return[q[0]/l,q[1]/l,q[2]/l,q[3]/l]}
GS.parseSplat=function(buf){
  const n=Math.floor(buf.byteLength/32),f=new Float32Array(buf),u=new Uint8Array(buf),st=new Store(n);
  for(let i=0;i<n;i++){const b=i*32,fi=i*8;
    st.add(f[fi],f[fi+1],f[fi+2],f[fi+3],f[fi+4],f[fi+5],norm4([(u[b+28]-128)/128,(u[b+29]-128)/128,(u[b+30]-128)/128,(u[b+31]-128)/128]),[u[b+24],u[b+25],u[b+26]],u[b+27],0,0,Math.random())}
  return st.done({source:'capture'});
};
// Captures come in many frames (COLMAP is y-down, Terra and ENU are z-up). Put the flattest axis up, the long tail of
// buildings and trees above the ground, the centre at the origin and the ground at y = 0.
GS.normalizeCapture=function(d,flip){
  const n=d.n,step=Math.max(1,Math.floor(n/60000)),S=[];for(let i=0;i<n;i+=step)if(d.col[i*4+3]>40)S.push([d.pos[i*3],d.pos[i*3+1],d.pos[i*3+2]]);
  const med=k=>{const a=S.map(p=>p[k]).sort((x,y)=>x-y);return a[a.length>>1]},c=[med(0),med(1),med(2)];
  const C=[[0,0,0],[0,0,0],[0,0,0]];S.forEach(p=>{const v=[p[0]-c[0],p[1]-c[1],p[2]-c[2]];for(let i=0;i<3;i++)for(let j=0;j<3;j++)C[i][j]+=v[i]*v[j]/S.length});
  const E=jacobi(C);let upv=E.vecs[E.order[2]],ax=E.vecs[E.order[0]];
  let sk=0;S.forEach(p=>{const t=(p[0]-c[0])*upv[0]+(p[1]-c[1])*upv[1]+(p[2]-c[2])*upv[2];sk+=t*t*t});if(sk<0)upv=upv.map(v=>-v);if(flip)upv=upv.map(v=>-v);
  const X=norm(ax.map((v,i)=>v-(ax[0]*upv[0]+ax[1]*upv[1]+ax[2]*upv[2])*upv[i])),Y=upv,Z=cross(X,Y);
  const qR=quatFromAxes([X[0],Y[0],Z[0]],[X[1],Y[1],Z[1]],[X[2],Y[2],Z[2]]);   // rows X,Y,Z as a rotation
  const hs=[];
  for(let i=0;i<n;i++){const i3=i*3,x=d.pos[i3]-c[0],y=d.pos[i3+1]-c[1],z=d.pos[i3+2]-c[2];
    d.pos[i3]=X[0]*x+X[1]*y+X[2]*z;d.pos[i3+1]=Y[0]*x+Y[1]*y+Y[2]*z;d.pos[i3+2]=Z[0]*x+Z[1]*y+Z[2]*z;
    const q=qmul(qR,[d.rot[i*4],d.rot[i*4+1],d.rot[i*4+2],d.rot[i*4+3]]);d.rot.set(q,i*4);if(i%step===0)hs.push(d.pos[i3+1])}
  hs.sort((a,b)=>a-b);const g0=hs[Math.floor(hs.length*.05)];const rr=[];
  for(let i=0;i<n;i++){d.pos[i*3+1]-=g0;if(i%step===0)rr.push(Math.hypot(d.pos[i*3],d.pos[i*3+2]))}
  rr.sort((a,b)=>a-b);d.radius=Math.max(1,rr[Math.floor(rr.length*.9)]);return d;
};
function jacobi(A){const a=A.map(r=>r.slice()),v=[[1,0,0],[0,1,0],[0,0,1]];
  for(let it=0;it<30;it++){let p=0,q=1;if(Math.abs(a[0][2])>Math.abs(a[p][q])){p=0;q=2}if(Math.abs(a[1][2])>Math.abs(a[p][q])){p=1;q=2}
    if(Math.abs(a[p][q])<1e-12)break;const th=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(th),s=Math.sin(th);
    for(let k=0;k<3;k++){const akp=a[k][p],akq=a[k][q];a[k][p]=c*akp-s*akq;a[k][q]=s*akp+c*akq}
    for(let k=0;k<3;k++){const apk=a[p][k],aqk=a[q][k];a[p][k]=c*apk-s*aqk;a[q][k]=s*apk+c*aqk}
    for(let k=0;k<3;k++){const vkp=v[k][p],vkq=v[k][q];v[k][p]=c*vkp-s*vkq;v[k][q]=s*vkp+c*vkq}}
  const vals=[a[0][0],a[1][1],a[2][2]],order=[0,1,2].sort((i,j)=>vals[j]-vals[i]);
  return{vals:vals,order:order,vecs:[0,1,2].map(j=>[v[0][j],v[1][j],v[2][j]])}}
// Standard 32-byte .splat: position, scale, rgba, rotation (w,x,y,z as bytes). Colours can be pre-lit with `lit`.
GS.toSplat=function(d,lit){const buf=new ArrayBuffer(d.n*32),f=new Float32Array(buf),u=new Uint8Array(buf);
  for(let i=0;i<d.n;i++){const b=i*32,fi=i*8;f[fi]=d.pos[i*3];f[fi+1]=d.pos[i*3+1];f[fi+2]=d.pos[i*3+2];f[fi+3]=d.scale[i*3];f[fi+4]=d.scale[i*3+1];f[fi+5]=d.scale[i*3+2];
    const c=lit?lit(i):[d.col[i*4],d.col[i*4+1],d.col[i*4+2]];u[b+24]=c[0];u[b+25]=c[1];u[b+26]=c[2];u[b+27]=d.col[i*4+3];
    for(let k=0;k<4;k++)u[b+28+k]=Math.max(0,Math.min(255,Math.round(d.rot[i*4+k]*128+128)))}
  return buf};

/* ---------- renderer ---------- */
const VS=`#version 300 es
precision highp float;precision highp int;precision highp usampler2D;precision highp sampler2D;
uniform usampler2D uData;uniform sampler2D uShade;
uniform mat4 uView,uProj;uniform vec2 uFocal,uViewport;
uniform float uReveal,uGrow,uRadius,uDay,uOverlay,uHasShade;uniform vec3 uSun;uniform vec3 uGrid;
in vec2 aCorner;in uint aIndex;out vec4 vColor;out vec2 vPos;
vec3 octDec(vec2 e){vec3 n=vec3(e.x,1.0-abs(e.x)-abs(e.y),e.y);if(n.y<0.0){n.x=(1.0-abs(e.y))*(e.x>=0.0?1.0:-1.0);n.z=(1.0-abs(e.x))*(e.y>=0.0?1.0:-1.0);}return normalize(n);}
void main(){
  ivec2 tc=ivec2(int((aIndex&1023u)<<1u),int(aIndex>>10u));
  uvec4 t0=texelFetch(uData,tc,0),t1=texelFetch(uData,tc+ivec2(1,0),0);
  vec3 c=uintBitsToFloat(t0.xyz);
  vec4 col=vec4(float(t0.w&255u),float((t0.w>>8u)&255u),float((t0.w>>16u)&255u),float(t0.w>>24u))/255.0;
  uint type=(t1.w>>16u)&15u;float rnd=float(t1.w>>24u)/255.0;
  vec3 nrm=octDec(vec2(float(t1.w&255u),float((t1.w>>8u)&255u))/255.0*2.0-1.0);
  float rr=length(c.xz)/uRadius;
  float t=clamp((uReveal-(rr*0.92+rnd*0.08))/0.2,0.0,1.0);
  if(type==5u)t=min(t,clamp(uGrow*0.9-rnd*0.35,0.0,1.0));
  if(t<=0.0){gl_Position=vec4(0.0,0.0,2.0,1.0);return;}
  float e=1.0-pow(1.0-t,3.0);
  vec3 p=c;p.y+=(1.0-e)*(1.5+7.0*rnd)*max(1.0,uRadius/150.0);
  p.xz+=(1.0-e)*normalize(c.xz+vec2(0.001,0.0))*(2.0+4.0*rnd);
  vec4 cam=uView*vec4(p,1.0);
  if(cam.z>-0.1){gl_Position=vec4(0.0,0.0,2.0,1.0);return;}
  vec4 clip=uProj*cam;vec2 ndc=clip.xy/clip.w;
  if(abs(ndc.x)>1.3||abs(ndc.y)>1.3){gl_Position=vec4(0.0,0.0,2.0,1.0);return;}
  vec2 u1=unpackHalf2x16(t1.x),u2=unpackHalf2x16(t1.y),u3=unpackHalf2x16(t1.z);
  mat3 V=mat3(u1.x,u1.y,u2.x,u1.y,u2.y,u3.x,u2.x,u3.x,u3.y);
  float sc=mix(0.05,1.0,e);V*=sc*sc;
  float iz=1.0/(-cam.z);
  mat3 J=mat3(uFocal.x*iz,0.0,0.0,0.0,uFocal.y*iz,0.0,uFocal.x*cam.x*iz*iz,uFocal.y*cam.y*iz*iz,0.0);
  mat3 T=J*mat3(uView);mat3 S=T*V*transpose(T);
  float a=S[0][0]+0.3,b=S[0][1],d=S[1][1]+0.3;
  float mid=0.5*(a+d),r=length(vec2(0.5*(a-d),b)),l1=mid+r,l2=max(mid-r,0.1);
  vec2 e1=abs(b)>1e-7?normalize(vec2(b,l1-a)):(a>=d?vec2(1.0,0.0):vec2(0.0,1.0));vec2 e2=vec2(-e1.y,e1.x);
  float r1=min(sqrt(l1),640.0),r2=min(sqrt(l2),640.0);
  vec3 rgb=col.rgb;float alpha=col.a;
  if(type!=0u){
    float vis=1.0;
    if(type==1u&&uHasShade>0.5){
      vec2 uv=(c.xz-uGrid.xy)/uGrid.z;
      if(uv.x>0.0&&uv.y>0.0&&uv.x<1.0&&uv.y<1.0){
        vec2 s=texture(uShade,uv).rg;vis=s.r;
        if(s.g>0.05)rgb=mix(rgb,vec3(0.73,0.70,0.65)*(0.92+0.16*rnd),0.8*s.g);
        if(uOverlay>0.5&&s.g>0.3){vec3 tint=vis>0.7?vec3(1.0,0.54,0.17):(vis>0.12?vec3(0.25,0.86,0.56):vec3(0.16,0.39,0.85));rgb=mix(rgb,tint,0.62*s.g);}
      }
    }
    float diff=max(dot(nrm,uSun),0.0)*vis*uDay;
    float amb=type==1u?0.46:(0.40+0.16*nrm.y);
    if(type==3u||type==5u){amb=0.52;diff*=0.85;}
    rgb*=vec3(0.60,0.67,0.80)*amb*1.3+vec3(1.0,0.94,0.83)*diff*0.95;
    alpha*=1.0-smoothstep(0.97,1.12,rr);
  }
  float glow=pow(1.0-e,1.5);
  rgb=mix(rgb,vec3(0.70,0.90,1.0)*1.6,glow);alpha*=mix(0.9,1.0,e);
  vColor=vec4(min(rgb,vec3(1.0)),alpha);
  vPos=aCorner*3.0;
  vec2 off=(aCorner.x*r1*e1+aCorner.y*r2*e2)*3.0;
  gl_Position=vec4(ndc+off*2.0/uViewport,0.0,1.0);
}`;
const FS=`#version 300 es
precision highp float;in vec4 vColor;in vec2 vPos;out vec4 frag;
void main(){float r2=dot(vPos,vPos);if(r2>9.0)discard;float a=vColor.a*exp(-0.5*r2);if(a<0.004)discard;frag=vec4(vColor.rgb*a,a);}`;
const SORTER=`let pos=null;
onmessage=e=>{const d=e.data;if(d.pos){pos=d.pos;return}if(!pos)return;
  const m=d.view,n=pos.length/3,z=new Float32Array(n);let lo=Infinity,hi=-Infinity;
  for(let i=0;i<n;i++){const v=m[2]*pos[3*i]+m[6]*pos[3*i+1]+m[10]*pos[3*i+2]+m[14];z[i]=v;if(v<lo)lo=v;if(v>hi)hi=v}
  const B=65536,sc=(B-1)/((hi-lo)||1),cnt=new Uint32Array(B),key=new Uint16Array(n);
  for(let i=0;i<n;i++){const k=((z[i]-lo)*sc)|0;key[i]=k;cnt[k]++}
  let acc=0;for(let i=0;i<B;i++){const c=cnt[i];cnt[i]=acc;acc+=c}
  const out=new Uint32Array(n);for(let i=0;i<n;i++)out[cnt[key[i]]++]=i;
  postMessage({order:out,id:d.id},[out.buffer])};`;

GS.Renderer=function(canvas){
  const gl=canvas.getContext('webgl2',{antialias:false,alpha:true,premultipliedAlpha:true,powerPreference:'high-performance'});
  if(!gl)throw new Error('This view needs WebGL2.');
  this.gl=gl;this.canvas=canvas;this.n=0;this.data=null;this.busy=false;this.lastView=null;this.sortId=0;
  const sh=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s};
  const pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,VS));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,FS));gl.linkProgram(pr);
  if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
  this.pr=pr;gl.useProgram(pr);
  this.U={};['uData','uShade','uView','uProj','uFocal','uViewport','uReveal','uGrow','uRadius','uDay','uOverlay','uHasShade','uSun','uGrid'].forEach(k=>this.U[k]=gl.getUniformLocation(pr,k));
  this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
  const qb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,qb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const la=gl.getAttribLocation(pr,'aCorner');gl.enableVertexAttribArray(la);gl.vertexAttribPointer(la,2,gl.FLOAT,false,0,0);
  this.ib=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.ib);
  const li=gl.getAttribLocation(pr,'aIndex');gl.enableVertexAttribArray(li);gl.vertexAttribIPointer(li,1,gl.UNSIGNED_INT,0,0);gl.vertexAttribDivisor(li,1);
  this.tex=gl.createTexture();this.shadeTex=gl.createTexture();this.hasShade=false;
  this.worker=new Worker(URL.createObjectURL(new Blob([SORTER],{type:'text/javascript'})));
  this.worker.onmessage=e=>{if(e.data.id!==this.sortId)return;gl.bindBuffer(gl.ARRAY_BUFFER,this.ib);gl.bufferData(gl.ARRAY_BUFFER,e.data.order,gl.DYNAMIC_DRAW);this.busy=false;this.sorted=true};
  this.reveal0=performance.now();this.grow0=-1e9;
};
const RP=GS.Renderer.prototype;
RP.setData=function(d,keepReveal){
  const gl=this.gl,n=d.n,rows=Math.max(1,Math.ceil(n/1024)),u=new Uint32Array(2048*rows*4),f=new Float32Array(u.buffer);
  for(let i=0;i<n;i++){const o=i*8,i3=i*3,i4=i*4;f[o]=d.pos[i3];f[o+1]=d.pos[i3+1];f[o+2]=d.pos[i3+2];
    u[o+3]=(d.col[i4]|(d.col[i4+1]<<8)|(d.col[i4+2]<<16)|(d.col[i4+3]<<24))>>>0;
    const w=d.rot[i4],x=d.rot[i4+1],y=d.rot[i4+2],z=d.rot[i4+3],sx=d.scale[i3],sy=d.scale[i3+1],sz=d.scale[i3+2];
    const m00=(1-2*(y*y+z*z))*sx,m01=2*(x*y-w*z)*sy,m02=2*(x*z+w*y)*sz,m10=2*(x*y+w*z)*sx,m11=(1-2*(x*x+z*z))*sy,m12=2*(y*z-w*x)*sz,m20=2*(x*z-w*y)*sx,m21=2*(y*z+w*x)*sy,m22=(1-2*(x*x+y*y))*sz;
    const c00=m00*m00+m01*m01+m02*m02,c01=m00*m10+m01*m11+m02*m12,c02=m00*m20+m01*m21+m02*m22,c11=m10*m10+m11*m11+m12*m12,c12=m10*m20+m11*m21+m12*m22,c22=m20*m20+m21*m21+m22*m22;
    u[o+4]=(toHalf(c00)|(toHalf(c01)<<16))>>>0;u[o+5]=(toHalf(c02)|(toHalf(c11)<<16))>>>0;u[o+6]=(toHalf(c12)|(toHalf(c22)<<16))>>>0;u[o+7]=d.meta[i]}
  gl.bindTexture(gl.TEXTURE_2D,this.tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32UI,2048,rows,0,gl.RGBA_INTEGER,gl.UNSIGNED_INT,u);
  const ident=new Uint32Array(n);for(let i=0;i<n;i++)ident[i]=i;
  gl.bindBuffer(gl.ARRAY_BUFFER,this.ib);gl.bufferData(gl.ARRAY_BUFFER,ident,gl.DYNAMIC_DRAW);
  this.n=n;this.data=d;this.radius=d.radius||100;this.sortId++;this.busy=false;this.lastView=null;this.sorted=false;
  this.worker.postMessage({pos:new Float32Array(d.pos)});
  if(!keepReveal)this.reveal0=performance.now();
};
RP.replay=function(){this.reveal0=performance.now()};
RP.grow=function(){this.grow0=performance.now()};
// shade grid for the current hour: vis (sun 1, tree shade 0.22, building shadow 0) and the walkway mask, smoothed by the GPU
RP.setShade=function(bytes,walk,n,ox,oz,size){
  const gl=this.gl,t=new Uint8Array(n*n*2);
  for(let i=0;i<n*n;i++){const v=bytes[i];t[i*2]=v===255||v===1?255:(v===90?56:0);t[i*2+1]=walk&&walk[i]===1?255:0}
  gl.bindTexture(gl.TEXTURE_2D,this.shadeTex);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RG8,n,n,0,gl.RG,gl.UNSIGNED_BYTE,t);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  this.grid=[ox,oz,size];this.hasShade=true};
RP.clearShade=function(){this.hasShade=false};
RP.revealDone=function(){return (performance.now()-this.reveal0)/1000*.42-.06>1.25};
RP.render=function(view,proj,o){
  const gl=this.gl,cv=this.canvas,dpr=Math.min(window.devicePixelRatio||1,o.dpr||1.5),w=Math.max(1,Math.round(cv.clientWidth*dpr)),h=Math.max(1,Math.round(cv.clientHeight*dpr));
  if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h}
  gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  if(!this.n)return;
  if(!this.busy){const lv=this.lastView,ch=!lv||Math.abs(lv[2]-view[2])+Math.abs(lv[6]-view[6])+Math.abs(lv[10]-view[10])>.002||Math.abs(lv[14]-view[14])>.05;
    if(ch){this.busy=true;this.lastView=Array.from(view);this.worker.postMessage({view:this.lastView,id:this.sortId})}}
  const U=this.U;gl.useProgram(this.pr);gl.bindVertexArray(this.vao);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.tex);gl.uniform1i(U.uData,0);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.shadeTex);gl.uniform1i(U.uShade,1);
  gl.uniformMatrix4fv(U.uView,false,view);gl.uniformMatrix4fv(U.uProj,false,proj);
  gl.uniform2f(U.uFocal,proj[0]*w/2,proj[5]*h/2);gl.uniform2f(U.uViewport,w,h);
  const now=performance.now();
  gl.uniform1f(U.uReveal,(now-this.reveal0)/1000*.42-.06);gl.uniform1f(U.uGrow,(now-this.grow0)/1000);
  gl.uniform1f(U.uRadius,this.radius);gl.uniform1f(U.uDay,o.day==null?1:o.day);gl.uniform1f(U.uOverlay,o.overlay?1:0);
  gl.uniform1f(U.uHasShade,this.hasShade?1:0);gl.uniform3fv(U.uSun,o.sun||[.4,.8,.3]);gl.uniform3fv(U.uGrid,this.grid||[0,0,1]);
  gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.n);
};
window.GS=GS;
})();
