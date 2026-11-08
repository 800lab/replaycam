// Small video-only MP4/WebM muxers. Every stored sample is independently decodable.
const text=value=>new TextEncoder().encode(value);
const concat=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.byteLength,0));let at=0;for(const part of parts){out.set(part,at);at+=part.byteLength;}return out;};
const u16=n=>new Uint8Array([(n>>>8)&255,n&255]);
const u32=n=>new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);
const zeros=n=>new Uint8Array(n);
const box=(name,...data)=>{const body=concat(data);return concat([u32(body.length+8),text(name),body]);};
const full=(name,version,flags,...data)=>box(name,new Uint8Array([version,(flags>>>16)&255,(flags>>>8)&255,flags&255]),...data);
const matrix=concat([u32(65536),u32(0),u32(0),u32(0),u32(65536),u32(0),u32(0),u32(0),u32(0x40000000)]);

function mp4(info,packets,durations){
  if(!info.decoderConfig.description)throw new Error('Missing AVC configuration');
  const duration=durations.reduce((n,x)=>n+x,0),timescale=1000000;
  const ftyp=box('ftyp',text('isom'),u32(512),text('isomiso2avc1mp41'));
  const table=[];for(const d of durations){const last=table.at(-1);if(last?.[1]===d)last[0]++;else table.push([1,d]);}
  const avc1=box('avc1',zeros(6),u16(1),zeros(16),u16(info.width),u16(info.height),u32(72*65536),u32(72*65536),u32(0),u16(1),zeros(32),u16(24),u16(65535),box('avcC',new Uint8Array(info.decoderConfig.description)));
  const movie=offset=>{
    const stbl=box('stbl',full('stsd',0,0,u32(1),avc1),full('stts',0,0,u32(table.length),...table.flatMap(x=>x.map(u32))),full('stsc',0,0,u32(1),u32(1),u32(packets.length),u32(1)),full('stsz',0,0,u32(0),u32(packets.length),...packets.map(x=>u32(x.data.length))),full('stco',0,0,u32(1),u32(offset)),full('stss',0,0,u32(packets.length),...packets.map((_,i)=>u32(i+1))));
    const minf=box('minf',full('vmhd',0,1,zeros(8)),box('dinf',full('dref',0,0,u32(1),full('url ',0,1))),stbl);
    const mdia=box('mdia',full('mdhd',0,0,zeros(8),u32(timescale),u32(duration),u16(0x55c4),u16(0)),full('hdlr',0,0,u32(0),text('vide'),zeros(12),text('VideoHandler\0')),minf);
    const trak=box('trak',full('tkhd',0,7,zeros(8),u32(1),u32(0),u32(Math.ceil(duration/1000)),zeros(8),zeros(8),matrix,u32(info.width*65536),u32(info.height*65536)),mdia);
    return box('moov',full('mvhd',0,0,zeros(8),u32(1000),u32(Math.ceil(duration/1000)),u32(65536),u16(256),zeros(10),matrix,zeros(24),u32(2)),trak);
  };
  const moov=movie(ftyp.length+movie(0).length+8),bytes=packets.reduce((n,p)=>n+p.data.length,0);
  return new Blob([ftyp,moov,u32(bytes+8),text('mdat'),...packets.map(p=>p.data)],{type:'video/mp4'});
}

function vint(n){for(let width=1;width<=8;width++)if(n<2**(7*width)-1){const out=new Uint8Array(width);let v=n;for(let i=width-1;i>=0;i--){out[i]=v%256;v=Math.floor(v/256);}out[0]|=1<<(8-width);return out;}throw new Error('EBML size too large');}
function id(hex){return new Uint8Array(hex.match(/../g).map(n=>parseInt(n,16)));}
const elem=(tag,data)=>concat([id(tag),vint(data.length),data]);
function integer(n){let width=1;while(n>=2**(width*8))width++;const out=new Uint8Array(width);for(let i=width-1;i>=0;i--){out[i]=n%256;n=Math.floor(n/256);}return out;}
const num=(tag,n)=>elem(tag,integer(n));
const float=(tag,n)=>{const out=new Uint8Array(8);new DataView(out.buffer).setFloat64(0,n);return elem(tag,out);};
const master=(tag,...parts)=>elem(tag,concat(parts));
function webm(info,packets,durations){
  const duration=durations.reduce((n,x)=>n+x,0)/1000;
  const header=master('1a45dfa3',num('4286',1),num('42f7',1),num('42f2',4),num('42f3',8),elem('4282',text('webm')),num('4287',4),num('4285',2));
  const metadata=master('1549a966',num('2ad7b1',1000000),float('4489',duration),elem('4d80',text('replaycam')),elem('5741',text('replaycam')));
  const tracks=master('1654ae6b',master('ae',num('d7',1),num('73c5',1),num('83',1),elem('86',text('V_VP8')),num('23e383',Math.round(durations[0]*1000)),master('e0',num('b0',info.width),num('ba',info.height))));
  const clusters=[],clusterTimes=[];let group=[],start=0,time=0;
  const flush=()=>{if(group.length){clusters.push(master('1f43b675',num('e7',Math.round(start)),...group));clusterTimes.push(start);}group=[];};
  for(let i=0;i<packets.length;i++){
    if(group.length&&time-start>=1000){flush();start=time;}
    const relative=Math.round(time-start),payload=concat([new Uint8Array([0x81,(relative>>>8)&255,relative&255,0x80]),packets[i].data]);
    group.push(elem('a3',payload));time+=durations[i]/1000;
  }flush();
  let position=metadata.length+tracks.length;const cues=[];
  for(const [i,cluster] of clusters.entries()){cues.push(master('bb',num('b3',Math.round(clusterTimes[i])),master('b7',num('f7',1),num('f1',position))));position+=cluster.length;}
  const body=[metadata,tracks,...clusters,master('1c53bb6b',...cues)];
  return new Blob([header,id('18538067'),vint(body.reduce((n,p)=>n+p.length,0)),...body],{type:'video/webm'});
}

export function createVideoFile(sequence,startMs,endMs,rate=1){
  if(![1,0.5].includes(rate)||!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<=startMs||endMs>sequence.duration+0.01)throw new Error('Invalid selection');
  const first=sequence.at(startMs),last=sequence.at(endMs),from=sequence.frames.indexOf(first),to=sequence.frames.indexOf(last);
  if(from<0||to<from)throw new Error('Empty selection');
  const frames=sequence.frames.slice(from,to+1),packets=frames.map(f=>f.image),info=packets[0].info;
  if(packets.some(p=>p.kind!=='video'||!p.data||p.type!=='key'||p.info!==info))throw new Error('Unsupported video samples');
  const total=packets.reduce((n,p)=>n+p.data.byteLength,0);if(total>32*1024*1024)throw new Error('Selected video exceeds 32 MiB');
  const normal=Math.round(1000000/info.fps);
  const durations=frames.map((f,i)=>Math.max(1,Math.round((i+1<frames.length?(frames[i+1].time-f.time)*1000:normal)/rate)));
  const blob=info.container==='mp4'?mp4(info,packets,durations):webm(info,packets,durations);
  return {blob,extension:info.container,duration:durations.reduce((n,x)=>n+x,0)/1000000,frames:frames.length,sourceStart:first.time,sourceEnd:last.time};
}

// The pixel-buffer fallback does not need WebCodecs to export. Encode only a
// user-selected, finite interval, after the camera has already been stopped.
function recorderType(){
  if(typeof MediaRecorder!=='function'||typeof HTMLCanvasElement==='undefined'||typeof HTMLCanvasElement.prototype.captureStream!=='function')return null;
  return ['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported?.(type))??(MediaRecorder.isTypeSupported?null:'');
}
export function canRecordVideo(){return recorderType()!==null;}

export function recordVideoFile(sequence,startMs,endMs,rate=1,{signal,onProgress=()=>{}}={}){
  return new Promise((resolve,reject)=>{
    let recorder,stream,canvas,timer,deadline,pixels,settled=false,completed=false,total=0;
    const chunks=[];
    const abortError=()=>new DOMException('Export cancelled','AbortError');
    const finish=(error,file)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(deadline);
      signal?.removeEventListener('abort',abort);
      if(recorder){recorder.ondataavailable=recorder.onstop=recorder.onerror=null;if(recorder.state!=='inactive')try{recorder.stop();}catch{}}
      stream?.getTracks().forEach(track=>track.stop());
      if(canvas)canvas.width=canvas.height=1;
      pixels=null;chunks.length=0;
      error?reject(error):resolve(file);
    };
    const abort=()=>finish(abortError());
    try{
      if(signal?.aborted)throw abortError();
      if(![1,.5].includes(rate)||!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<=startMs||endMs>sequence.duration+.01||endMs-startMs>30000)throw new Error('Invalid selection');
      const type=recorderType(),first=sequence.at(startMs),last=sequence.at(endMs);
      if(type===null||!first||!last||first.image.kind==='video')throw new Error('Recording not supported');
      const fps=Math.min(15,sequence.fps||15),duration=(last.time-first.time+1000/fps)/rate;
      if(duration<=0||duration>61000)throw new Error('Invalid duration');
      canvas=document.createElement('canvas');canvas.width=first.image.width;canvas.height=first.image.height;
      const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw new Error('Canvas unavailable');
      const draw=position=>{
        const frame=sequence.at(position),image=frame?.image;if(!image)throw abortError();
        if(image.data){pixels??=ctx.createImageData(image.width,image.height);image.copyRGBA(pixels.data);ctx.putImageData(pixels,0,0);}
        else ctx.drawImage(image,0,0);
      };
      draw(first.time-sequence.start);
      stream=canvas.captureStream(fps);
      if(stream.getVideoTracks().length!==1||stream.getAudioTracks().length)throw new Error('Invalid export stream');
      recorder=new MediaRecorder(stream,{...(type?{mimeType:type}:{}),videoBitsPerSecond:2500000});
      const mime=recorder.mimeType||type,extension=mime.startsWith('video/mp4')?'mp4':mime.startsWith('video/webm')?'webm':null;
      if(!extension)throw new Error('Unsupported recording format');
      recorder.ondataavailable=event=>{
        if(settled||!event.data?.size)return;
        total+=event.data.size;
        if(total>32*1024*1024){finish(new Error('Selected video exceeds 32 MiB'));return;}
        chunks.push(event.data);
      };
      recorder.onerror=()=>finish(new Error('Video recording failed'));
      recorder.onstop=()=>{
        if(settled)return;
        if(!completed){finish(new Error('Video recording stopped early'));return;}
        if(!total){finish(new Error('Empty recording'));return;}
        finish(null,{blob:new Blob(chunks,{type:mime}),extension,duration:duration/1000,sourceStart:first.time,sourceEnd:last.time});
      };
      signal?.addEventListener('abort',abort,{once:true});
      // Includes the stop/flush stage: a recorder that never fires onstop is
      // bounded too. All exit paths release its canvas, timers and tracks.
      deadline=setTimeout(()=>finish(new Error('Video recording timed out')),duration+10000);
      recorder.start(250);
      const started=performance.now();let previous=started;
      const step=()=>{
        if(settled)return;
        try{
          const now=performance.now(),elapsed=now-started;
          if(now-previous>1500)throw new Error('Video recording stalled');
          previous=now;
          draw(Math.min(last.time-sequence.start,first.time-sequence.start+elapsed*rate));
          onProgress(Math.min(elapsed,duration),duration);
          if(elapsed>=duration){completed=true;recorder.stop();return;}
          timer=setTimeout(step,1000/fps);
        }catch(error){finish(error);}
      };
      step();
    }catch(error){finish(error);}
  });
}
