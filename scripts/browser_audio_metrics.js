(function(root) {
  function instrumentAudioWorklet(source) {
    const constructor='this.left = 0;';
    const registration="registerProcessor('ps2-output', Output);";
    if(source.split(constructor).length!==2 || source.split(registration).length!==2 || source.includes('this.qa ='))
      throw new Error('Audio metrics require the uninstrumented production worklet');
    return source.replace(constructor,
      'this.qa = new Int32Array(options.processorOptions.qaBuffer,0,16); this.stats = new Float64Array(options.processorOptions.qaBuffer,128,8); '+constructor)
      .replace(registration,`
        const original = Output.prototype.process;
        Output.prototype.process = function(inputs,outputs) {
          if(Atomics.load(this.qa,0)!==1)return original.call(this,inputs,outputs);
          const readBefore=Atomics.load(this.ring,1);
          const available=(Atomics.load(this.ring,0)-readBefore)>>>0;
          const result=original.call(this,inputs,outputs);
          // Only this worklet writes the read counter. Count what playback
          // actually consumed: a producer may refill after the earlier snapshot.
          const consumed=(Atomics.load(this.ring,1)-readBefore)>>>0;
          const left=outputs[0][0],right=outputs[0][1];
          const missing=Math.max(0,left.length-consumed);
          const estimatedMissing=Math.max(0,left.length-available);
          this.qa[1]++;this.qa[2]+=left.length;this.qa[3]+=missing;
          if(missing)this.qa[4]++;
          this.qa[8]=Math.min(this.qa[8],available);this.qa[9]=Math.max(this.qa[9],available);
          this.qa[11]+=estimatedMissing;this.qa[12]+=consumed;
          if(estimatedMissing>missing)this.qa[13]++;
          for(let i=0;i<left.length;i++){
            const l=left[i],r=right[i];
            this.qa[5]=Math.max(this.qa[5],Math.round(Math.max(Math.abs(l),Math.abs(r))*32768));
            if(l===0&&r===0)this.qa[6]++;
            if(l<=-1||l>=32767/32768||r<=-1||r>=32767/32768)this.qa[7]++;
            if(l!==r)this.qa[10]++;
            this.stats[0]+=l*l;this.stats[1]+=r*r;
          }
          return result;
        };
        ${registration}`);
  }
  if(typeof module==='object'&&module.exports)module.exports={instrumentAudioWorklet};
  else root.ssx3InstrumentAudioWorklet=instrumentAudioWorklet;
})(globalThis);
