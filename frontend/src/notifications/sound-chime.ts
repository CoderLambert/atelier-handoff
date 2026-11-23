/**
 * @file 使用 Web Audio API 合成运行完成提示音与状态音效。
 * @implementation 采用高精度纯音振荡器配合自然谐波包络衰减，无需外部音频资源，离线即时播放。
 * @updated 2026-11-23T15:35:00+08:00
 */

class SoundChimePlayer {
  private ctx: AudioContext | null = null;

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!this.ctx || this.ctx.state === 'closed') {
      try {
        this.ctx = new AudioContextClass();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
  }

  playCompletionChime(volume = 80): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const normalizedVolume = Math.max(0, Math.min(100, volume)) / 100;
    if (normalizedVolume <= 0) return;

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(normalizedVolume * 0.45, now);
    masterGain.connect(ctx.destination);

    // 双音清脆和弦铃声：D5 (587.33 Hz) -> A5 (880.00 Hz)
    this.playTone(ctx, masterGain, 587.33, now, 0.28, 'sine');
    this.playTone(ctx, masterGain, 880.0, now + 0.12, 0.48, 'sine');
    // 叠加微弱三角泛音增加通透质感
    this.playTone(ctx, masterGain, 1174.66, now + 0.12, 0.35, 'triangle', 0.18);
  }

  playFailureChime(volume = 80): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const normalizedVolume = Math.max(0, Math.min(100, volume)) / 100;
    if (normalizedVolume <= 0) return;

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(normalizedVolume * 0.4, now);
    masterGain.connect(ctx.destination);

    // 低柔双音提示：A4 (440.00 Hz) -> F4 (349.23 Hz)
    this.playTone(ctx, masterGain, 440.0, now, 0.22, 'sine');
    this.playTone(ctx, masterGain, 349.23, now + 0.14, 0.38, 'sine');
  }

  private playTone(
    ctx: AudioContext,
    destination: AudioNode,
    frequency: number,
    startTime: number,
    duration: number,
    type: OscillatorType = 'sine',
    gainScale = 1.0,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, startTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(0.3 * gainScale, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }
}

export const soundChime = new SoundChimePlayer();
