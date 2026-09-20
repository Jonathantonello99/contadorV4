import React, { useEffect, useMemo, useRef, useState } from 'react';

const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';
const ROI_MARGIN = 0.04;
const median = (xs) => { const a=[...xs].sort((x,y)=>x-y); if(!a.length)return 0; const i=Math.floor(a.length/2); return a.length%2?a[i]:(a[i-1]+a[i])/2; };
const mean = (xs) => xs.length ? xs.reduce((s,x)=>s+x,0)/xs.length : 0;
const stdev = (xs) => { if(xs.length<2)return 0; const m=mean(xs); return Math.sqrt(xs.reduce((s,x)=>s+(x-m)**2,0)/(xs.length-1)); };

export default function App() {
  const videoRef=useRef(null), displayRef=useRef(null), workRef=useRef(null), streamRef=useRef(null);
  const backgroundRef=useRef(null), profileRef=useRef(null), historyRef=useRef([]), rafRef=useRef(0), lastProcessRef=useRef(0);
  const [cvReady,setCvReady]=useState(false), [devices,setDevices]=useState([]), [deviceId,setDeviceId]=useState('');
  const [count,setCount]=useState(0), [status,setStatus]=useState('Carregando OpenCV...'), [stabilizing,setStabilizing]=useState(true);
  const [backgroundOk,setBackgroundOk]=useState(false), [profile,setProfile]=useState(null), [calibrating,setCalibrating]=useState(false);
  const [threshold,setThreshold]=useState(30), [minArea,setMinArea]=useState(20), [running,setRunning]=useState(true), [overlay,setOverlay]=useState(true), [debug,setDebug]=useState(false);
  const [averageArea,setAverageArea]=useState(0), [averageDiameter,setAverageDiameter]=useState(0), [debugClusters,setDebugClusters]=useState([]);
  const [refSizeMm,setRefSizeMm]=useState(50),[refColor,setRefColor]=useState({h:110,s:190,v:190}),[refStatus,setRefStatus]=useState('Aguardando referência'),[pxPerMm,setPxPerMm]=useState(0),[samplingColor,setSamplingColor]=useState(false);
  const scaleHistoryRef=useRef([]);

  useEffect(()=>{
    let alive=true, timer;
    async function check(){
      try{
        if(!window.cv)return;
        const cv = window.cv instanceof Promise ? await window.cv : window.cv;
        if(cv?.Mat && alive){ window.cv=cv; setCvReady(true); setStatus('OpenCV pronto • selecione a câmera'); clearInterval(timer); }
      }catch(e){ console.error(e); }
    }
    if(!document.querySelector(`script[src="${OPENCV_URL}"]`)){
      const script=document.createElement('script'); script.src=OPENCV_URL; script.async=true; document.head.appendChild(script);
    }
    timer=setInterval(check,200); check();
    return()=>{alive=false; clearInterval(timer);};
  },[]);

  const stopCamera=()=>{ streamRef.current?.getTracks().forEach(t=>t.stop()); streamRef.current=null; };
  const listCameras=async()=>{
    try{
      const permission=await navigator.mediaDevices.getUserMedia({video:true,audio:false}); permission.getTracks().forEach(t=>t.stop());
      const cams=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput'); setDevices(cams);
      if(!deviceId && cams[0])setDeviceId(cams[0].deviceId);
    }catch(e){ console.error(e); setStatus('Autorize o acesso à câmera no Chrome'); }
  };
  useEffect(()=>{ listCameras(); return()=>stopCamera(); },[]);
  useEffect(()=>{
    if(!deviceId)return;
    (async()=>{
      try{
        stopCamera();
        const s=await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:deviceId},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:false});
        streamRef.current=s; videoRef.current.srcObject=s; await videoRef.current.play();
        backgroundRef.current?.delete(); backgroundRef.current=null; profileRef.current=null; historyRef.current=[];
        setBackgroundOk(false); setProfile(null); setCount(0); setAverageArea(0); setAverageDiameter(0); setStabilizing(true); setStatus('Câmera ativa • calibre o fundo vazio');
      }catch(e){ console.error(e); setStatus('Não foi possível abrir esta câmera'); }
    })();
  },[deviceId]);

  const readFrame=()=>{
    const video=videoRef.current, canvas=workRef.current;
    if(!video||!canvas||video.readyState<2||!video.videoWidth)return null;
    const width=Math.min(1440,video.videoWidth), height=Math.round(width*video.videoHeight/video.videoWidth);
    canvas.width=width; canvas.height=height; canvas.getContext('2d',{willReadFrequently:true}).drawImage(video,0,0,width,height);
    return window.cv.imread(canvas);
  };
  const roiRect=(m)=>{ const x=Math.round(m.cols*ROI_MARGIN), y=Math.round(m.rows*ROI_MARGIN); return new window.cv.Rect(x,y,Math.round(m.cols*(1-2*ROI_MARGIN)),Math.round(m.rows*(1-2*ROI_MARGIN))); };
  const grayRoi=(frame)=>{ const cv=window.cv, src=frame.roi(roiRect(frame)), gray=new cv.Mat(), blur=new cv.Mat(); cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray,blur,new cv.Size(3,3),0); src.delete(); gray.delete(); return blur; };
  const createMask=(frame)=>{
    if(!backgroundRef.current)return null;
    const cv=window.cv, gray=grayRoi(frame), diff=new cv.Mat(), mask=new cv.Mat();
    if(gray.rows!==backgroundRef.current.rows||gray.cols!==backgroundRef.current.cols){gray.delete();diff.delete();mask.delete();return null;}
    cv.absdiff(gray,backgroundRef.current,diff); cv.threshold(diff,mask,threshold,255,cv.THRESH_BINARY);
    const kernel=cv.getStructuringElement(cv.MORPH_ELLIPSE,new cv.Size(3,3)); cv.morphologyEx(mask,mask,cv.MORPH_OPEN,kernel); cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,kernel); kernel.delete(); gray.delete(); diff.delete(); return mask;
  };
  const components=(mask)=>{ const cv=window.cv,l=new cv.Mat(),s=new cv.Mat(),c=new cv.Mat(); const n=cv.connectedComponentsWithStats(mask,l,s,c,8,cv.CV_32S); return{n,l,s,c}; };


  const detectReference=(frame)=>{const cv=window.cv,r=roiRect(frame),src=frame.roi(r),rgb=new cv.Mat(),hsv=new cv.Mat(),m=new cv.Mat();cv.cvtColor(src,rgb,cv.COLOR_RGBA2RGB);cv.cvtColor(rgb,hsv,cv.COLOR_RGB2HSV);const low=new cv.Mat(hsv.rows,hsv.cols,hsv.type(),[Math.max(0,refColor.h-18),Math.max(0,refColor.s-80),Math.max(0,refColor.v-90),0]),high=new cv.Mat(hsv.rows,hsv.cols,hsv.type(),[Math.min(179,refColor.h+18),255,255,255]);cv.inRange(hsv,low,high,m);const k=cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(5,5));cv.morphologyEx(m,m,cv.MORPH_CLOSE,k);const cs=new cv.MatVector(),hier=new cv.Mat();cv.findContours(m,cs,hier,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);let best=null;for(let i=0;i<cs.size();i++){const c=cs.get(i),a=cv.contourArea(c),peri=cv.arcLength(c,true),ap=new cv.Mat();cv.approxPolyDP(c,ap,.03*peri,true);if(a>500&&ap.rows===4){const b=cv.boundingRect(ap),ratio=b.width/b.height;if(ratio>.7&&ratio<1.3&&(!best||a>best.area))best={area:a,x:b.x,y:b.y,w:b.width,h:b.height};}ap.delete();c.delete();}cs.delete();hier.delete();k.delete();low.delete();high.delete();rgb.delete();hsv.delete();src.delete();if(!best){m.delete();setRefStatus('Referência não detectada');return null;}const scale=((best.w+best.h)/2)/Math.max(1,refSizeMm);scaleHistoryRef.current.push(scale);if(scaleHistoryRef.current.length>12)scaleHistoryRef.current.shift();best.scale=median(scaleHistoryRef.current);best.mask=m;setPxPerMm(best.scale);setRefStatus('Referência detectada • escala corrigida');return best;};
  const sampleReferenceColor=(e)=>{if(!samplingColor||!displayRef.current)return;const cv=window.cv,b=displayRef.current.getBoundingClientRect(),f=readFrame();if(!f)return;const x=Math.max(0,Math.min(f.cols-1,Math.round((e.clientX-b.left)/b.width*f.cols))),y=Math.max(0,Math.min(f.rows-1,Math.round((e.clientY-b.top)/b.height*f.rows)));const rgb=new cv.Mat(1,1,cv.CV_8UC3),hsv=new cv.Mat(),px=f.ucharPtr(y,x),dst=rgb.ucharPtr(0,0);dst[0]=px[0];dst[1]=px[1];dst[2]=px[2];cv.cvtColor(rgb,hsv,cv.COLOR_RGB2HSV);const hp=hsv.ucharPtr(0,0);setRefColor({h:hp[0],s:hp[1],v:hp[2]});setSamplingColor(false);setRefStatus('Cor aprendida • procurando quadrado');rgb.delete();hsv.delete();f.delete();};

  const calibrateBackground=async()=>{
    if(!cvReady||calibrating||!streamRef.current)return;
    const cv=window.cv; setCalibrating(true); setStatus('Capturando fundo • mantenha a superfície vazia e imóvel');
    let acc=null,n=0;
    try{
      for(let i=0;i<20;i++){
        await new Promise(r=>setTimeout(r,60)); const f=readFrame(); if(!f)continue; const g=grayRoi(f),x=new cv.Mat(); g.convertTo(x,cv.CV_32F);
        if(!acc)acc=cv.Mat.zeros(x.rows,x.cols,cv.CV_32F); cv.add(acc,x,acc); n++; x.delete(); g.delete(); f.delete();
      }
      if(n<6)throw new Error('frames insuficientes'); acc.convertTo(acc,cv.CV_32F,1/n); const b=new cv.Mat(); acc.convertTo(b,cv.CV_8U); acc.delete();
      backgroundRef.current?.delete(); backgroundRef.current=b; profileRef.current=null; historyRef.current=[]; setBackgroundOk(true); setProfile(null); setCount(0); setStabilizing(true); setStatus('Fundo pronto • coloque 20–50 grãos separados');
    }catch(e){console.error(e);setStatus(`Falha na calibração: ${e.message}`);}finally{setCalibrating(false);}
  };

  const calibrateGrains=()=>{
    const f=readFrame(); if(!f)return; const m=createMask(f); if(!m){f.delete();return;}
    const cv=window.cv,q=components(m),samples=[];
    for(let i=1;i<q.n;i++){
      const area=q.s.intAt(i,cv.CC_STAT_AREA),w=q.s.intAt(i,cv.CC_STAT_WIDTH),h=q.s.intAt(i,cv.CC_STAT_HEIGHT),ratio=Math.max(w,h)/Math.max(1,Math.min(w,h));
      if(area>=minArea&&area<m.rows*m.cols*.01&&ratio<2.7)samples.push({area,diameter:2*Math.sqrt(area/Math.PI),ratio});
    }
    q.l.delete();q.s.delete();q.c.delete();m.delete();f.delete();
    if(samples.length<8){setStatus('Calibração insuficiente • mostre pelo menos 8 grãos separados');return;}
    const areas=samples.map(x=>x.area),p={samples:samples.length,areaMedian:median(areas),areaMean:mean(areas),areaStd:stdev(areas),diameterMedian:median(samples.map(x=>x.diameter)),ratioMedian:median(samples.map(x=>x.ratio))};
    profileRef.current=p; setProfile(p); historyRef.current=[]; setStabilizing(true); setStatus(`Perfil aprendido com ${samples.length} grãos • contagem ativa`);
  };

  const analyze=(mask)=>{
    const cv=window.cv,q=components(mask),p=profileRef.current,objects=[],clusters=[]; let total=0,totalArea=0;
    for(let i=1;i<q.n;i++){
      const area=q.s.intAt(i,cv.CC_STAT_AREA); if(area<minArea)continue;
      const x=q.s.intAt(i,cv.CC_STAT_LEFT),y=q.s.intAt(i,cv.CC_STAT_TOP),w=q.s.intAt(i,cv.CC_STAT_WIDTH),h=q.s.intAt(i,cv.CC_STAT_HEIGHT),cx=q.c.doubleAt(i,0),cy=q.c.doubleAt(i,1);
      let units=1,confidence=1,areaEstimate=1,bestSeeds=1;
      if(p){
        areaEstimate=Math.max(1,Math.round(area/p.areaMedian));
        if(area>p.areaMedian*1.42||Math.max(w,h)>p.diameterMedian*2){
          const local=mask.roi(new cv.Rect(x,y,w,h)),dist=new cv.Mat(),peaks=new cv.Mat(),markers=new cv.Mat(); cv.distanceTransform(local,dist,cv.DIST_L2,3); const max=cv.minMaxLoc(dist).maxVal;
          let bestScore=Infinity,bestUnits=areaEstimate;
          for(const ratio of [.25,.30,.35,.40,.45,.50,.55,.60]){
            cv.threshold(dist,peaks,max*ratio,255,cv.THRESH_BINARY);peaks.convertTo(peaks,cv.CV_8U);const seeds=Math.max(1,cv.connectedComponents(peaks,markers,8,cv.CV_32S)-1),candidate=Math.max(seeds,areaEstimate),predicted=area/candidate,sizeError=Math.abs(predicted-p.areaMedian)/p.areaMedian,countGap=Math.abs(seeds-areaEstimate)/Math.max(1,areaEstimate),score=.8*sizeError+.2*countGap;
            if(score<bestScore){bestScore=score;bestUnits=candidate;bestSeeds=seeds;}
          }
          units=Math.max(1,bestUnits);confidence=Math.max(0,1-bestScore);clusters.push({id:i,area,areaEstimate,seeds:bestSeeds,units,confidence}); local.delete();dist.delete();peaks.delete();markers.delete();
        }
      }
      total+=units;totalArea+=area;objects.push({x:cx,y:cy,units,cluster:units>1});
    }
    q.l.delete();q.s.delete();q.c.delete();return{total,avgArea:total?totalArea/total:0,objects,clusters};
  };

  const stabilize=(raw)=>{
    const h=historyRef.current;h.push(raw);if(h.length>9)h.shift();
    if(h.length<5)return{value:raw,stable:false};
    const freq={};h.forEach(v=>freq[v]=(freq[v]||0)+1);const best=Object.entries(freq).sort((a,b)=>b[1]-a[1])[0];
    return best[1]>=5?{value:Number(best[0]),stable:true}:{value:Math.round(median(h)),stable:false};
  };
  const render=(f,m,a)=>{
    const cv=window.cv,out=f.clone(),r=roiRect(f),view=out.roi(r);
    if(overlay){const pink=new cv.Mat(view.rows,view.cols,view.type(),new cv.Scalar(255,20,147,255)),blend=new cv.Mat();cv.addWeighted(view,.55,pink,.45,0,blend);blend.copyTo(view,m);for(const o of a.objects)cv.circle(view,new cv.Point(Math.round(o.x),Math.round(o.y)),o.cluster?5:2,o.cluster?new cv.Scalar(255,215,0,255):new cv.Scalar(255,255,255,255),-1);pink.delete();blend.delete();}
    cv.rectangle(out,new cv.Point(r.x,r.y),new cv.Point(r.x+r.width,r.y+r.height),new cv.Scalar(255,20,147,255),2);cv.imshow(displayRef.current,out);view.delete();out.delete();
  };

  useEffect(()=>{
    if(!cvReady)return;
    const loop=(now)=>{
      rafRef.current=requestAnimationFrame(loop);if(!running||now-lastProcessRef.current<170)return;lastProcessRef.current=now;const f=readFrame();if(!f)return;
      try{
        if(!backgroundRef.current){window.cv.imshow(displayRef.current,f);return;}
        const reference=detectReference(f);const m=createMask(f);if(!m){reference?.mask?.delete();return;}if(reference?.mask){const x=Math.max(0,reference.x-8),y=Math.max(0,reference.y-8),w=Math.min(m.cols-x,reference.w+16),h=Math.min(m.rows-y,reference.h+16),sub=m.roi(new cv.Rect(x,y,w,h));sub.setTo(new cv.Scalar(0));sub.delete();}const a=analyze(m),s=stabilize(a.total);setCount(s.value);setStabilizing(!s.stable);setAverageArea(Math.round(a.avgArea));setAverageDiameter(a.avgArea?2*Math.sqrt(a.avgArea/Math.PI):0);setDebugClusters(a.clusters.slice(0,12));render(f,m,a);reference?.mask?.delete();m.delete();
      }catch(e){console.error(e);setStabilizing(true);}finally{f.delete();}
    };
    rafRef.current=requestAnimationFrame(loop);return()=>cancelAnimationFrame(rafRef.current);
  },[cvReady,running,threshold,minArea,overlay]);

  const quality=useMemo(()=>profile?Math.round(Math.max(0,Math.min(100,100-(profile.areaStd/Math.max(1,profile.areaMean))*180))):0,[profile]);
  return <div className="app"><canvas ref={workRef} hidden/><header><div><h1>Contador de Grãos V3</h1><p>Webcam + OpenCV.js • calibração estatística • separação adaptativa</p></div><b className={cvReady?'ok':'wait'}>{cvReady?'OpenCV pronto':'Carregando OpenCV'}</b></header><main><section className="camera"><div className="stage"><video ref={videoRef} autoPlay playsInline muted/><canvas ref={displayRef} onClick={sampleReferenceColor} className={samplingColor?'sampling':''}/></div><div className="bar"><select value={deviceId} onChange={e=>setDeviceId(e.target.value)}>{devices.map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||`Câmera ${i+1}`}</option>)}</select><button onClick={listCameras}>Atualizar câmeras</button><button onClick={()=>setRunning(v=>!v)}>{running?'Pausar':'Continuar'}</button></div>{debug&&debugClusters.length>0&&<div className="debug"><h3>Aglomerados analisados</h3>{debugClusters.map(c=><div className="cluster" key={c.id}>#{c.id} • área {Math.round(c.area)} • área→{c.areaEstimate} • centros→{c.seeds} • final→{c.units} • confiança {Math.round(c.confidence*100)}%</div>)}</div>}</section><aside><div className="card center"><small>QUANTIDADE</small><div className="number">{count.toLocaleString('pt-BR')}</div><div className="metrics"><div><small>TAMANHO MÉDIO</small><b>{averageArea.toLocaleString('pt-BR')} px²</b></div><div><small>DIÂMETRO EQUIV.</small><b>{averageDiameter.toFixed(1)} px</b></div></div><div className="msg">{status}</div><div className={`count-status ${stabilizing?'stabilizing':'precise'}`}><span>{stabilizing?'●':'✓'}</span><strong>{stabilizing?'Estabilizando':'Contagem estabilizada'}</strong></div></div><div className="card reference"><h3>Referência métrica permanente</h3><p>Deixe um quadrado colorido de tamanho conhecido sempre visível no mesmo plano dos grãos.</p><label>Lado conhecido: {refSizeMm} mm<input type="range" min="10" max="150" value={refSizeMm} onChange={e=>setRefSizeMm(Number(e.target.value))}/></label><button onClick={()=>setSamplingColor(true)}>{samplingColor?'CLIQUE NO QUADRADO NA IMAGEM':'CALIBRAR COR DO QUADRADO'}</button><div className={pxPerMm?'ref-ok':'ref-warn'}>{refStatus}</div>{pxPerMm>0&&<div className="profile"><span>Escala <b>{pxPerMm.toFixed(2)} px/mm</b></span><span>Área média real <b>{(averageArea/(pxPerMm*pxPerMm)).toFixed(2)} mm²</b></span><span>Diâmetro médio real <b>{(averageDiameter/pxPerMm).toFixed(2)} mm</b></span></div>}</div><div className="card"><h3>Calibração avançada</h3><p>1. Fundo totalmente vazio. 2. Depois coloque 20–50 grãos bem separados.</p><button className="pink" disabled={!cvReady||calibrating||!streamRef.current} onClick={calibrateBackground}>{calibrating?'CAPTURANDO...':'1. CALIBRAR FUNDO'}</button><button disabled={!backgroundOk} onClick={calibrateGrains}>2. APRENDER PERFIL DOS GRÃOS</button>{profile&&<div className="profile"><span>Amostras <b>{profile.samples}</b></span><span>Área mediana <b>{Math.round(profile.areaMedian)} px²</b></span><span>Área média <b>{Math.round(profile.areaMean)} px²</b></span><span>Desvio <b>{Math.round(profile.areaStd)} px²</b></span><span>Diâmetro típico <b>{profile.diameterMedian.toFixed(1)} px</b></span><span>Qualidade <b>{quality}%</b></span></div>}</div><div className="card"><h3>Ajustes</h3><label>Sensibilidade: {threshold}<input type="range" min="8" max="100" value={threshold} onChange={e=>setThreshold(Number(e.target.value))}/></label><label>Área mínima: {minArea}<input type="range" min="5" max="500" value={minArea} onChange={e=>setMinArea(Number(e.target.value))}/></label><label><input type="checkbox" checked={overlay} onChange={e=>setOverlay(e.target.checked)}/> Overlay rosa</label><label><input type="checkbox" checked={debug} onChange={e=>setDebug(e.target.checked)}/> Debug / precisão</label></div></aside></main></div>;
}
