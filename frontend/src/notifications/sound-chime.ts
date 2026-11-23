/**
 * @file 使用 Web Audio API 合成多种风格的运行完成提示音与状态音效。
 * @implementation 提供 Codex 纯净微音、双音和弦钟声、温润木琴、灵动水泡和极简短鸣等音效，零外部资源依赖。
 * @updated 2026-11-23T16:35:00+08:00
 */
import type { SoundTheme } from '@shared/desktop-ui-notifications';

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

  playCompletionChime(theme: SoundTheme = 'codex', volume = 80): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const normalizedVolume = Math.max(0, Math.min(100, volume)) / 100;
    if (normalizedVolume <= 0) return;

    switch (theme) {
      case 'codex':
        this.playCodexGlass(ctx, normalizedVolume);
        break;
      case 'chime':
        this.playHarmonicChime(ctx, normalizedVolume);
        break;
      case 'marimba':
        this.playWarmMarimba(ctx, normalizedVolume);
        break;
      case 'bubble':
        this.playPlayfulBubble(ctx, normalizedVolume);
        break;
      case 'ping':
        this.playMinimalPing(ctx, normalizedVolume);
        break;
      default:
        this.playCodexGlass(ctx, normalizedVolume);
        break;
    }
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

  /**
   * Codex 纯净玻璃微音 (经典 Glass / AI CLI 风格)
   * 高频清脆晶莹的敲击与余韵，富有科技感且低干扰。
   */
  private playCodexGlass(ctx: AudioContext, volume: number): void {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(volume * 0.42, now);
    master.connect(ctx.destination);

    // 主音敲击：1200 Hz (D6)，微弱泛音 2400 Hz 和 3600 Hz
    this.playTone(ctx, master, 1200, now, 0.32, 'sine', 0.8);
    this.playTone(ctx, master, 2400, now, 0.18, 'sine', 0.25);
    this.playTone(ctx, master, 3600, now, 0.1, 'sine', 0.1);

    // 稍微延后的第二共鸣泛音：1800 Hz
    this.playTone(ctx, master, 1800, now + 0.045, 0.28, 'sine', 0.4);
  }

  /**
   * 双音和弦钟声 (经典优雅)
   * D5 -> A5 上行四度双音，温暖通透。
   */
  private playHarmonicChime(ctx: AudioContext, volume: number): void {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(volume * 0.42, now);
    master.connect(ctx.destination);

    this.playTone(ctx, master, 587.33, now, 0.28, 'sine');
    this.playTone(ctx, master, 880.0, now + 0.12, 0.48, 'sine');
    this.playTone(ctx, master, 1174.66, now + 0.12, 0.35, 'triangle', 0.18);
  }

  /**
   * 温润木琴 (Acoustic Marimba)
   * C5 -> E5 -> G5 快速三和弦轻敲，自然饱满。
   */
  private playWarmMarimba(ctx: AudioContext, volume: number): void {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(volume * 0.45, now);
    master.connect(ctx.destination);

    this.playTone(ctx, master, 523.25, now, 0.22, 'sine', 0.9);
    this.playTone(ctx, master, 659.25, now + 0.065, 0.22, 'sine', 0.9);
    this.playTone(ctx, master, 783.99, now + 0.13, 0.38, 'sine', 1.0);
  }

  /**
   * 灵动水泡 (Playful Bubble)
   * 柔和音调滑频 + 气泡微爆破。
   */
  private playPlayfulBubble(ctx: AudioContext, volume: number): void {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(volume * 0.4, now);
    master.connect(ctx.destination);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.09);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

    osc.connect(gain);
    gain.connect(master);

    osc.start(now);
    osc.stop(now + 0.25);

    // 水泡高频反弹
    this.playTone(ctx, master, 1318.5, now + 0.08, 0.14, 'sine', 0.3);
  }

  /**
   * 极简短鸣 (Minimal Ping)
   * 纯正高频单音，简短克制。
   */
  private playMinimalPing(ctx: AudioContext, volume: number): void {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(volume * 0.38, now);
    master.connect(ctx.destination);

    this.playTone(ctx, master, 1046.5, now, 0.18, 'sine', 0.9);
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
    gain.gain.exponentialRampToValueAtTime(0.3 * gainScale, startTime + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }
}

export const soundChime = new SoundChimePlayer();
