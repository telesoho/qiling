//! 听音乐：读系统正在播放的声音，先区分音乐/人声，再估计能量与节拍。
//!
//! 采集走 Windows WASAPI 回环（默认播放设备），只在本机内存里做实时分析：
//! 不录音、不落盘、不上传。分析结果每 50ms 发一次 `qiling-music-sense`
//! （带 `music` 与 `bpmConfidence`），每到一个估计拍点再发一条 `qiling-music-beat`。
//!
//! 音乐/人声判别用全带宽起音包络的节拍规律（覆盖率、占空比、强弱规整度）、
//! 低频占比和最近 1 秒的响度占空比，并带进入/退出滞回；语音、噪声和零散音效
//! 不会驱动三档。BPM 用 6 秒起音包络的自相关 + 梳状评分 + 速度先验 + 节拍网格，
//! 支持 40–200 BPM，并处理半拍/双拍歧义。
//!
//! 能量口径仍对齐设计原型 `design/characters/lingpao/sheets/lingpao-groove.html`：
//! 2048 点 FFT + Blackman 窗 + AnalyserNode 的 −90…−18 dB 归一化
//! （`FFT_DB_OFFSET` 把未归一化幅度换算到同一 dB 标尺）+ 0.68 平滑，
//! 再用原型的 `bass * 1.32 + mid * 0.28 + rms * 0.4` 与 5 / 1.4 的非对称平滑。
//! 原型滑块阈值 0.60 / 0.30 就是照这套数值调出来的，改这里要重新对照原型。

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

const SAMPLE_RATE_FALLBACK: u32 = 48_000;
const FFT_SIZE: usize = 2048;
/// 原型每帧 rAF（约 60Hz）读一次 analyser；这里按音频时间每 16ms 跑一帧。
const FRAME_SECONDS: f32 = 0.016;
/// 由 `_workshop/test-120bpm.wav` 对原型能量序列拟合得到（MAE≈0.012）。
const FFT_DB_OFFSET: f32 = -69.0;
const MIN_DB: f32 = -90.0;
const MAX_DB: f32 = -18.0;
const ANALYSER_SMOOTHING: f32 = 0.68;
const BASS_WEIGHT: f32 = 1.32;
const MID_WEIGHT: f32 = 0.28;
const RMS_WEIGHT: f32 = 0.40;
const ENERGY_ATTACK: f32 = 5.0;
const ENERGY_RELEASE: f32 = 1.4;
const BASS_BAND: (f32, f32) = (35.0, 160.0);
const MID_BAND: (f32, f32) = (160.0, 1800.0);
/// 数字回环在静音时是 0，这两个门限只需滤掉底噪和短提示音。
const LOUD_RMS: f32 = 0.0005;
const QUIET_RMS: f32 = 0.00015;
const START_SECONDS: f32 = 1.2;
const STOP_SECONDS: f32 = 3.5;
const EMIT_SECONDS: f64 = 0.05;

/// 起音强度包络（onset strength envelope）的分频带：40 Hz–8 kHz 对数分 24 段。
/// 全带宽而不是只看低频，才能抓到反拍、踩镲和副歌里没有底鼓的拍点。
const OSE_BAND_COUNT: usize = 24;
const OSE_BAND_LOW_HZ: f32 = 40.0;
const OSE_BAND_HIGH_HZ: f32 = 8000.0;
/// 用慢均值去掉持续音造成的缓慢起伏，只留下真正的起音。
const OSE_HIGHPASS_SECONDS: f32 = 0.4;
/// 窗口太短时自相关不可信；先让灵泡按备用拍摇摆。
const TEMPO_MIN_SECONDS: f32 = 2.5;
/// 速度估计窗口约 6 秒，足够覆盖 40 BPM 的 4 拍，也让半拍/双拍有足够证据。
const MAX_HISTORY_FRAMES: usize = 400;
const TEMPO_UPDATE_SECONDS: f64 = 0.5;
/// 动画可用的速度范围；60 BPM（半拍）原来落在 70 下限之外，是“半拍识别不出来”的直接原因。
const MIN_BPM: f32 = 40.0;
const MAX_BPM: f32 = 200.0;
/// 音乐/语音门限：进入/退出分开，避免在边界抖动。
/// 真实系统回环的起步段常只有 0.2–0.35 的节奏证据（前奏、弱拍、房间声），
/// 但语音通常低于 0.2，所以门限要按实测回环标定，不能只按合成音轨。
const MUSIC_ENTER_SCORE: f32 = 0.32;
const MUSIC_EXIT_SCORE: f32 = 0.20;
/// 用户可调阈值的硬边界：低于 0.05 几乎任何声音都会被判成音乐。
const MIN_TUNED_SCORE: f32 = 0.05;
const MIN_TUNED_GAP: f32 = 0.01;
/// 进入音乐状态要连续这么多秒达到门限：语音偶尔也能碰到 0.3，但撑不住 1 秒。
const MUSIC_ENTER_HOLD_SECONDS: f32 = 1.0;
const MUSIC_EXIT_HOLD_SECONDS: f32 = 1.0;
/// 速度估计“不可信”也要连续这么久才把 BPM 收回 0：门限附近的判定会逐帧翻转，
/// 不驻留的话界面上的 BPM 会时有时无，灵泡也会在真实拍点和 96 备用拍之间来回切。
const TEMPO_DOWNGRADE_HOLD_SECONDS: f32 = 1.0;
/// 速度候选与上一拍相差超过 8% 时，要连续两次估计一致才切换，避免半拍/双拍来回跳。
const BPM_SWITCH_RATIO: f32 = 0.08;
const BPM_SWITCH_CONFIRM: u8 = 2;

/// 用户在设定页调整的音乐判定阈值。
///
/// 只暴露会影响“是不是音乐”的两个分数；进入和退出分开，保留滞回。
/// 字段用 camelCase 与前端设置一致，`default` 让旧前端只传一个字段时不会失败。
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MusicTuning {
    pub enter_score: f32,
    pub exit_score: f32,
}

impl Default for MusicTuning {
    fn default() -> Self {
        Self {
            enter_score: MUSIC_ENTER_SCORE,
            exit_score: MUSIC_EXIT_SCORE,
        }
    }
}

impl MusicTuning {
    /// 把前端传来的值收敛到可用范围，保证退出阈值严格低于进入阈值。
    fn sanitized(self) -> Self {
        let enter_score = if self.enter_score.is_finite() {
            self.enter_score.clamp(MIN_TUNED_SCORE, 0.95)
        } else {
            MUSIC_ENTER_SCORE
        };
        let max_exit = (enter_score - MIN_TUNED_GAP).max(MIN_TUNED_GAP);
        let exit_score = if self.exit_score.is_finite() {
            self.exit_score.clamp(MIN_TUNED_GAP, max_exit)
        } else {
            MUSIC_EXIT_SCORE.min(max_exit)
        };
        Self {
            enter_score,
            exit_score,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicSenseStatus {
    pub running: bool,
    pub supported: bool,
    pub last_error: Option<String>,
    /// 最近一次分析快照；没在监听时为默认值。
    pub active: bool,
    pub music: bool,
    pub bpm: f32,
    pub bpm_confidence: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MusicSnapshot {
    /// 有持续声音在播放（能量门槛），不代表一定是音乐。
    pub active: bool,
    /// 规则判定为音乐；人声、噪声、零散音效为 false。
    pub music: bool,
    pub energy: f32,
    pub bass: f32,
    pub bpm: f32,
    pub bpm_confidence: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AnalysisEvent {
    Sense(MusicSnapshot),
    Beat,
}

struct Inner {
    running: AtomicBool,
    /// 每次 start 递增；旧线程退出时不能把新会话标记成“未运行”。
    generation: AtomicU64,
    /// 当前会话自己的停止标志；换会话时旧的标志不会被新会话重置。
    session_stop: Mutex<Option<Arc<AtomicBool>>>,
    last_error: Mutex<Option<String>>,
    /// 最近一次分析结果，供设定页显示“听到了什么”。
    latest: Mutex<Option<MusicSnapshot>>,
    /// 用户在设定页调整的阈值；运行中也能改，采集线程会轮流读取。
    tuning: Mutex<MusicTuning>,
}

pub struct MusicSense {
    inner: Arc<Inner>,
}

impl Default for MusicSense {
    fn default() -> Self {
        Self::new()
    }
}

impl MusicSense {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                running: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                session_stop: Mutex::new(None),
                last_error: Mutex::new(None),
                latest: Mutex::new(None),
                tuning: Mutex::new(MusicTuning::default()),
            }),
        }
    }

    pub fn start(&self, app: AppHandle) -> Result<bool, String> {
        if !cfg!(windows) {
            return Err("music_unsupported".into());
        }
        if self.inner.running.swap(true, Ordering::SeqCst) {
            return Ok(true);
        }
        if let Ok(mut error) = self.inner.last_error.lock() {
            *error = None;
        }
        if let Ok(mut latest) = self.inner.latest.lock() {
            *latest = None;
        }
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let tuning = self.tuning();
        let stop = Arc::new(AtomicBool::new(false));
        if let Ok(mut session) = self.inner.session_stop.lock() {
            *session = Some(Arc::clone(&stop));
        }

        #[cfg(windows)]
        {
            let (ready_tx, ready_rx) = mpsc::channel::<Result<(), &'static str>>();
            let inner = Arc::clone(&self.inner);
            let session_stop = Arc::clone(&stop);
            thread::spawn(move || {
                platform::run(inner, app, session_stop, generation, ready_tx, tuning)
            });
            match ready_rx.recv_timeout(Duration::from_secs(2)) {
                Ok(Ok(())) => Ok(true),
                Ok(Err(code)) => {
                    self.set_error(code);
                    self.finish_session(generation);
                    Err(code.into())
                }
                Err(_) => {
                    stop.store(true, Ordering::SeqCst);
                    self.set_error("music_start_failed");
                    self.finish_session(generation);
                    Err("music_start_failed".into())
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = app;
            self.finish_session(generation);
            Err("music_unsupported".into())
        }
    }

    pub fn stop(&self) -> Result<(), String> {
        if let Ok(mut session) = self.inner.session_stop.lock() {
            if let Some(stop) = session.take() {
                stop.store(true, Ordering::SeqCst);
            }
        }
        self.inner.running.store(false, Ordering::SeqCst);
        if let Ok(mut latest) = self.inner.latest.lock() {
            *latest = None;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        let _ = self.stop();
    }

    fn tuning(&self) -> MusicTuning {
        self.inner
            .tuning
            .lock()
            .map(|tuning| *tuning)
            .unwrap_or_default()
    }

    /// 设定页改阈值时调用；运行中的采集线程会在下一轮读到新值。
    pub fn configure(&self, tuning: MusicTuning) {
        if let Ok(mut current) = self.inner.tuning.lock() {
            *current = tuning.sanitized();
        }
    }

    /// 线程退出或启动失败时调用；已被更新的会话取代时不改状态。
    fn finish_session(&self, generation: u64) {
        if self.inner.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        self.inner.running.store(false, Ordering::SeqCst);
        if let Ok(mut session) = self.inner.session_stop.lock() {
            *session = None;
        }
    }

    pub fn status(&self) -> MusicSenseStatus {
        let latest = self.inner.latest.lock().ok().and_then(|value| *value);
        MusicSenseStatus {
            running: self.inner.running.load(Ordering::SeqCst),
            supported: cfg!(windows),
            last_error: self
                .inner
                .last_error
                .lock()
                .ok()
                .and_then(|error| error.clone()),
            active: latest.map(|snapshot| snapshot.active).unwrap_or(false),
            music: latest.map(|snapshot| snapshot.music).unwrap_or(false),
            bpm: latest.map(|snapshot| snapshot.bpm).unwrap_or(0.0),
            bpm_confidence: latest
                .map(|snapshot| snapshot.bpm_confidence)
                .unwrap_or(0.0),
        }
    }

    fn set_error(&self, code: &str) {
        if let Ok(mut error) = self.inner.last_error.lock() {
            *error = Some(code.to_string());
        }
    }
}

fn emit_events(app: &AppHandle, inner: &Inner, events: Vec<AnalysisEvent>) {
    for event in events {
        match event {
            AnalysisEvent::Sense(snapshot) => {
                if let Ok(mut latest) = inner.latest.lock() {
                    *latest = Some(snapshot);
                }
                let _ = app.emit(
                    "qiling-music-sense",
                    json!({
                        "active": snapshot.active,
                        "music": snapshot.music,
                        "energy": round_to(snapshot.energy, 3),
                        "bass": round_to(snapshot.bass, 3),
                        "bpm": round_to(snapshot.bpm, 1),
                        "bpmConfidence": round_to(snapshot.bpm_confidence, 3),
                    }),
                );
            }
            AnalysisEvent::Beat => {
                let _ = app.emit("qiling-music-beat", ());
            }
        }
    }
}

fn round_to(value: f32, digits: u32) -> f32 {
    let factor = 10f32.powi(digits as i32);
    (value * factor).round() / factor
}

// ---------------------------------------------------------------------------
// 分析与 FFT（平台无关，可单测）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct AudioFormat {
    channels: u16,
    sample_rate: u32,
    block_align: u16,
    bits: u16,
    float: bool,
}

impl AudioFormat {
    fn sample_bytes(self) -> usize {
        (self.bits / 8) as usize
    }

    fn decode(&self, bytes: &[u8], out: &mut Vec<f32>) -> Result<(), &'static str> {
        let frame_bytes = self.block_align as usize;
        if frame_bytes == 0 || bytes.len() % frame_bytes != 0 {
            return Err("music_capture_failed");
        }
        out.clear();
        out.reserve(bytes.len() / frame_bytes);
        for frame in bytes.chunks_exact(frame_bytes) {
            let mut sum = 0.0f32;
            for channel in 0..self.channels as usize {
                let offset = channel * self.sample_bytes();
                let value = if self.float {
                    if self.bits != 32 {
                        return Err("music_format_unsupported");
                    }
                    f32::from_le_bytes(
                        frame[offset..offset + 4]
                            .try_into()
                            .map_err(|_| "music_capture_failed")?,
                    )
                } else {
                    match self.bits {
                        16 => {
                            i16::from_le_bytes([frame[offset], frame[offset + 1]]) as f32 / 32_768.0
                        }
                        24 => {
                            let raw = (frame[offset] as i32)
                                | ((frame[offset + 1] as i32) << 8)
                                | ((frame[offset + 2] as i32) << 16);
                            let signed = (raw << 8) >> 8;
                            signed as f32 / 8_388_608.0
                        }
                        32 => {
                            i32::from_le_bytes([
                                frame[offset],
                                frame[offset + 1],
                                frame[offset + 2],
                                frame[offset + 3],
                            ]) as f32
                                / 2_147_483_648.0
                        }
                        _ => return Err("music_format_unsupported"),
                    }
                };
                sum += value;
            }
            out.push(sum / self.channels as f32);
        }
        Ok(())
    }
}

struct Fft {
    n: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
    reversed: Vec<usize>,
}

impl Fft {
    fn new(n: usize) -> Self {
        debug_assert!(n.is_power_of_two());
        let bits = n.trailing_zeros();
        let reversed = (0..n)
            .map(|index| index.reverse_bits() >> (usize::BITS - bits))
            .collect();
        let mut cos = Vec::with_capacity(n / 2);
        let mut sin = Vec::with_capacity(n / 2);
        for index in 0..n / 2 {
            let angle = -2.0 * std::f32::consts::PI * index as f32 / n as f32;
            cos.push(angle.cos());
            sin.push(angle.sin());
        }
        Self {
            n,
            cos,
            sin,
            reversed,
        }
    }

    fn transform(&self, re: &mut [f32], im: &mut [f32]) {
        for index in 0..self.n {
            let target = self.reversed[index];
            if target > index {
                re.swap(index, target);
                im.swap(index, target);
            }
        }
        let mut length = 2;
        while length <= self.n {
            let half = length / 2;
            let step = self.n / length;
            let mut start = 0;
            while start < self.n {
                for offset in 0..half {
                    let twiddle = offset * step;
                    let wr = self.cos[twiddle];
                    let wi = self.sin[twiddle];
                    let left = start + offset;
                    let right = left + half;
                    let xr = re[right] * wr - im[right] * wi;
                    let xi = re[right] * wi + im[right] * wr;
                    re[right] = re[left] - xr;
                    im[right] = im[left] - xi;
                    re[left] += xr;
                    im[left] += xi;
                }
                start += length;
            }
            length <<= 1;
        }
    }
}

fn blackman(n: usize) -> Vec<f32> {
    let a0 = 0.42f32;
    let a1 = 0.5f32;
    let a2 = 0.08f32;
    (0..n)
        .map(|index| {
            let phase = 2.0 * std::f32::consts::PI * index as f32 / (n - 1) as f32;
            a0 - a1 * phase.cos() + a2 * (2.0 * phase).cos()
        })
        .collect()
}

/// 按原型 `readMusicFeatures` 的口径把一帧频谱归一化。
fn normalize_db(magnitude: f32) -> f32 {
    let db = 20.0 * magnitude.max(1e-12).log10() + FFT_DB_OFFSET;
    ((db - MIN_DB) / (MAX_DB - MIN_DB)).clamp(0.0, 1.0)
}

/// 一个速度候选在起音网格上的证据。
struct GridInfo {
    /// 最佳相位（相对估计窗口起点的帧数）。
    phase: f32,
    /// 落在网格点 ±1 帧内的起音能量占比。
    cover: f32,
    /// 网格中点的起音能量 / 网格点的起音能量；越高说明网格漏掉了真实拍点。
    offbeat: f32,
    /// 有能量的网格点占比；半拍被当成整拍时只有一半网格点有起音。
    occupancy: f32,
    /// 网格点强弱的规整度（1 表示每拍一样强）；八分音符被当成整拍时会交替强弱。
    regularity: f32,
}

#[derive(Clone, Copy)]
struct TempoEstimate {
    bpm: f32,
    /// 自相关梳状得分（0…1）。
    confidence: f32,
    /// 最佳拍长处的自相关值，用于判断“有没有稳定拍”。
    pulse: f32,
    cover: f32,
    phase: f32,
    score: f32,
    occupancy: f32,
    regularity: f32,
}

pub struct MusicAnalyser {
    ring: Vec<f32>,
    position: usize,
    filled: usize,
    pending: usize,
    frame_samples: usize,
    window: Vec<f32>,
    fft: Fft,
    re: Vec<f32>,
    im: Vec<f32>,
    buffer: Vec<f32>,
    hz_per_bin: f32,
    bass_bins: std::ops::Range<usize>,
    mid_bins: std::ops::Range<usize>,
    total_bins: std::ops::Range<usize>,
    /// 24 个对数频带，用于计算全带宽起音包络。
    ose_bins: Vec<std::ops::Range<usize>>,
    ose_band_log: Vec<f32>,
    ose_highpass: f32,
    smooth_bass: f32,
    smooth_mid: f32,
    energy: f32,
    active: bool,
    loud_seconds: f32,
    quiet_seconds: f32,
    /// 最近窗口的起音包络、响度、低频占比与音色特征。
    ose: VecDeque<f32>,
    rms_history: VecDeque<f32>,
    bass_ratio_history: VecDeque<f32>,
    zcr_history: VecDeque<f32>,
    centroid_history: VecDeque<f32>,
    flatness_history: VecDeque<f32>,
    music: bool,
    music_score: f32,
    tuning: MusicTuning,
    music_enter_seconds: f32,
    music_exit_seconds: f32,
    bpm: f32,
    bpm_confidence: f32,
    /// 连续“速度不可信”的秒数；用来给收回 BPM 加驻留。
    tempo_downgrade_seconds: f32,
    pending_bpm: f32,
    pending_bpm_count: u8,
    last_tempo_at: f64,
    beat_period: f64,
    next_beat: f64,
    last_beat_emitted: f64,
    clock: f64,
    last_emit: f64,
}

impl MusicAnalyser {
    pub fn new(sample_rate: u32) -> Self {
        let rate = if sample_rate > 0 {
            sample_rate
        } else {
            SAMPLE_RATE_FALLBACK
        };
        let hz_per_bin = rate as f32 / FFT_SIZE as f32;
        let bass_bins = bin_range(hz_per_bin, BASS_BAND);
        let mid_bins = bin_range(hz_per_bin, MID_BAND);
        let total_bins = bin_range(hz_per_bin, (35.0, 8000.0));
        let mut ose_bins = Vec::with_capacity(OSE_BAND_COUNT);
        let ratio = OSE_BAND_HIGH_HZ / OSE_BAND_LOW_HZ;
        for index in 0..OSE_BAND_COUNT {
            let low = OSE_BAND_LOW_HZ * ratio.powf(index as f32 / OSE_BAND_COUNT as f32);
            let high = OSE_BAND_LOW_HZ * ratio.powf((index + 1) as f32 / OSE_BAND_COUNT as f32);
            ose_bins.push(bin_range(hz_per_bin, (low, high)));
        }
        let frame_samples = ((rate as f32 * FRAME_SECONDS).round() as usize).max(1);
        Self {
            ring: vec![0.0; FFT_SIZE],
            position: 0,
            filled: 0,
            pending: 0,
            frame_samples,
            window: blackman(FFT_SIZE),
            fft: Fft::new(FFT_SIZE),
            re: vec![0.0; FFT_SIZE],
            im: vec![0.0; FFT_SIZE],
            buffer: vec![0.0; FFT_SIZE],
            hz_per_bin,
            bass_bins,
            mid_bins,
            total_bins,
            ose_bins,
            ose_band_log: vec![0.0; OSE_BAND_COUNT],
            ose_highpass: 0.0,
            smooth_bass: 0.0,
            smooth_mid: 0.0,
            energy: 0.0,
            active: false,
            loud_seconds: 0.0,
            quiet_seconds: 0.0,
            ose: VecDeque::with_capacity(MAX_HISTORY_FRAMES),
            rms_history: VecDeque::with_capacity(MAX_HISTORY_FRAMES),
            bass_ratio_history: VecDeque::with_capacity(MAX_HISTORY_FRAMES),
            zcr_history: VecDeque::with_capacity(MAX_HISTORY_FRAMES),
            centroid_history: VecDeque::with_capacity(MAX_HISTORY_FRAMES),
            flatness_history: VecDeque::with_capacity(MAX_HISTORY_FRAMES),
            music: false,
            music_score: 0.0,
            tuning: MusicTuning::default(),
            music_enter_seconds: 0.0,
            music_exit_seconds: 0.0,
            bpm: 0.0,
            bpm_confidence: 0.0,
            tempo_downgrade_seconds: 0.0,
            pending_bpm: 0.0,
            pending_bpm_count: 0,
            last_tempo_at: f64::NEG_INFINITY,
            beat_period: 0.0,
            next_beat: 0.0,
            last_beat_emitted: f64::NEG_INFINITY,
            clock: 0.0,
            last_emit: -1.0,
        }
    }

    /// 设定页调整阈值后由采集线程调用；不会清空已经累积的音频特征。
    pub fn set_tuning(&mut self, tuning: MusicTuning) {
        self.tuning = tuning.sanitized();
    }

    pub fn push(&mut self, samples: &[f32]) -> Vec<AnalysisEvent> {
        let mut events = Vec::new();
        for &sample in samples {
            self.write(sample);
            if self.pending >= self.frame_samples {
                self.pending -= self.frame_samples;
                self.run_frame(&mut events);
            }
        }
        events
    }

    pub fn push_zeros(&mut self, count: usize) -> Vec<AnalysisEvent> {
        let mut events = Vec::new();
        for _ in 0..count {
            self.write(0.0);
            if self.pending >= self.frame_samples {
                self.pending -= self.frame_samples;
                self.run_frame(&mut events);
            }
        }
        events
    }

    fn write(&mut self, sample: f32) {
        self.ring[self.position] = sample;
        self.position = (self.position + 1) % FFT_SIZE;
        if self.filled < FFT_SIZE {
            self.filled += 1;
        }
        self.pending += 1;
    }

    fn run_frame(&mut self, events: &mut Vec<AnalysisEvent>) {
        self.clock += FRAME_SECONDS as f64;
        // 按时间顺序取出窗口；还没填满时前面补零。
        let missing = FFT_SIZE - self.filled;
        let start = if self.filled == FFT_SIZE {
            self.position
        } else {
            0
        };
        for index in 0..FFT_SIZE {
            self.buffer[index] = if index < missing {
                0.0
            } else {
                self.ring[(start + index - missing) % FFT_SIZE]
            };
        }

        let mut square_sum = 0.0f32;
        for index in 0..FFT_SIZE {
            let sample = self.buffer[index];
            square_sum += sample * sample;
            self.re[index] = sample * self.window[index];
            self.im[index] = 0.0;
        }
        let rms = (square_sum / FFT_SIZE as f32).sqrt();
        self.fft.transform(&mut self.re, &mut self.im);

        let bass = self.band_average(&self.bass_bins.clone());
        let mid = self.band_average(&self.mid_bins.clone());
        self.smooth_bass =
            ANALYSER_SMOOTHING * self.smooth_bass + (1.0 - ANALYSER_SMOOTHING) * bass;
        self.smooth_mid = ANALYSER_SMOOTHING * self.smooth_mid + (1.0 - ANALYSER_SMOOTHING) * mid;

        let target =
            (self.smooth_bass * BASS_WEIGHT + self.smooth_mid * MID_WEIGHT + rms * RMS_WEIGHT)
                .clamp(0.0, 1.0);
        let rate = if target > self.energy {
            ENERGY_ATTACK
        } else {
            ENERGY_RELEASE
        };
        self.energy += (target - self.energy) * (1.0 - (-(FRAME_SECONDS * rate)).exp());

        self.update_presence(rms);
        self.push_features(rms);
        if self.active {
            self.tick_tempo(events);
        } else {
            self.reset_music_state();
        }

        if self.clock - self.last_emit >= EMIT_SECONDS {
            self.last_emit = self.clock;
            events.push(AnalysisEvent::Sense(MusicSnapshot {
                active: self.active,
                music: self.music,
                energy: self.energy,
                bass: self.smooth_bass,
                bpm: self.bpm,
                bpm_confidence: self.bpm_confidence,
            }));
        }
    }

    fn band_average(&self, bins: &std::ops::Range<usize>) -> f32 {
        if bins.start >= bins.end || bins.end > FFT_SIZE / 2 {
            return 0.0;
        }
        let mut sum = 0.0;
        for bin in bins.clone() {
            let magnitude = (self.re[bin] * self.re[bin] + self.im[bin] * self.im[bin]).sqrt();
            sum += normalize_db(magnitude);
        }
        sum / (bins.end - bins.start) as f32
    }

    fn band_power(&self, bins: &std::ops::Range<usize>) -> f32 {
        if bins.start >= bins.end || bins.end > FFT_SIZE / 2 {
            return 0.0;
        }
        let mut sum = 0.0;
        for bin in bins.clone() {
            sum += self.re[bin] * self.re[bin] + self.im[bin] * self.im[bin];
        }
        sum
    }

    fn update_presence(&mut self, rms: f32) {
        if rms > LOUD_RMS {
            self.loud_seconds += FRAME_SECONDS;
            self.quiet_seconds = 0.0;
        } else if rms < QUIET_RMS {
            self.quiet_seconds += FRAME_SECONDS;
            self.loud_seconds = 0.0;
        }
        if !self.active && self.loud_seconds >= START_SECONDS {
            self.active = true;
        }
        if self.active && self.quiet_seconds >= STOP_SECONDS {
            self.active = false;
            self.reset_analysis_history();
        }
    }

    /// 累积速度与音乐判断需要的特征；安静时段不写入，避免窗口被静音稀释。
    fn push_features(&mut self, rms: f32) {
        if !self.active && rms < QUIET_RMS {
            return;
        }

        let mut flux = 0.0f32;
        for (index, bins) in self.ose_bins.iter().enumerate() {
            if bins.start >= bins.end || bins.end > FFT_SIZE / 2 {
                continue;
            }
            let mut magnitude_sum = 0.0f32;
            for bin in bins.clone() {
                magnitude_sum += (self.re[bin] * self.re[bin] + self.im[bin] * self.im[bin]).sqrt();
            }
            let level = (magnitude_sum * 60.0).ln_1p();
            let rise = level - self.ose_band_log[index];
            if rise > 0.0 {
                flux += rise;
            }
            self.ose_band_log[index] = level;
        }
        let alpha = 1.0 - (-FRAME_SECONDS / OSE_HIGHPASS_SECONDS).exp();
        self.ose_highpass += (flux - self.ose_highpass) * alpha;
        let onset = (flux - self.ose_highpass).max(0.0);

        let bass_power = self.band_power(&self.bass_bins.clone());
        let total_power = self.band_power(&self.total_bins.clone());
        let bass_ratio = if total_power > 1e-12 {
            (bass_power / total_power).clamp(0.0, 1.0)
        } else {
            0.0
        };

        // 音色特征：清辅音多的语音过零率高、频谱重心高；音乐（即使很轻的抒情歌）更偏低频、
        // 更接近谐波。它们与节拍无关，用来兜住“没有明显鼓点”的慢歌。
        let mut crossings = 0usize;
        let mut previous_positive = self.buffer[0] >= 0.0;
        for &sample in &self.buffer[1..] {
            let positive = sample >= 0.0;
            if positive != previous_positive {
                crossings += 1;
            }
            previous_positive = positive;
        }
        let zcr = crossings as f32 / (FFT_SIZE - 1) as f32;

        let start = (100.0 / self.hz_per_bin).floor().max(1.0) as usize;
        let end = ((8000.0 / self.hz_per_bin).ceil() as usize).min(FFT_SIZE / 2);
        let mut magnitude_sum = 0.0f32;
        let mut weighted_hz = 0.0f32;
        let mut log_power = 0.0f32;
        let mut power_sum = 0.0f32;
        let mut bins = 0usize;
        if start < end {
            for bin in start..end {
                let magnitude = (self.re[bin] * self.re[bin] + self.im[bin] * self.im[bin]).sqrt();
                let power = magnitude * magnitude + 1e-12;
                magnitude_sum += magnitude;
                weighted_hz += magnitude * bin as f32 * self.hz_per_bin;
                log_power += power.ln();
                power_sum += power;
                bins += 1;
            }
        }
        let centroid = if magnitude_sum > 1e-12 {
            weighted_hz / magnitude_sum
        } else {
            0.0
        };
        let flatness = if bins > 0 && power_sum > 1e-12 {
            (log_power / bins as f32).exp() / (power_sum / bins as f32)
        } else {
            0.0
        };

        push_bounded(&mut self.ose, onset);
        push_bounded(&mut self.rms_history, rms);
        push_bounded(&mut self.bass_ratio_history, bass_ratio);
        push_bounded(&mut self.zcr_history, zcr);
        push_bounded(&mut self.centroid_history, centroid);
        push_bounded(&mut self.flatness_history, flatness);
    }

    fn tick_tempo(&mut self, events: &mut Vec<AnalysisEvent>) {
        if self.clock - self.last_tempo_at >= TEMPO_UPDATE_SECONDS {
            self.last_tempo_at = self.clock;
            if let Some(estimate) = self.estimate_tempo() {
                if self.apply_tempo(&estimate) {
                    self.update_music(&estimate);
                }
            } else if self.music {
                // 连起音包络都平了（音乐真的停了）：尽快退出，而不是等 3.5s 静音判定。
                self.music_exit_seconds += TEMPO_UPDATE_SECONDS as f32;
                if self.music_exit_seconds >= MUSIC_EXIT_HOLD_SECONDS {
                    self.reset_music_state();
                }
            }
        }
        self.emit_beat_if_due(events);
    }

    fn estimate_tempo(&self) -> Option<TempoEstimate> {
        let count = self.ose.len();
        if count < (TEMPO_MIN_SECONDS / FRAME_SECONDS) as usize {
            return None;
        }
        let values: Vec<f32> = self.ose.iter().copied().collect();
        let mean = values.iter().sum::<f32>() / count as f32;
        let variance: f32 = values.iter().map(|value| (value - mean).powi(2)).sum();
        if variance <= 1e-9 {
            return None;
        }

        let min_lag = (60.0 / MAX_BPM / FRAME_SECONDS).round().max(2.0) as usize;
        let max_lag = ((60.0 / MIN_BPM / FRAME_SECONDS).round() as usize).min(count - 2);
        if max_lag <= min_lag + 2 {
            return None;
        }
        let mut autocorrelation = vec![0.0f32; max_lag + 1];
        for lag in min_lag..=max_lag {
            let mut sum = 0.0f32;
            for index in 0..count - lag {
                sum += (values[index] - mean) * (values[index + lag] - mean);
            }
            autocorrelation[lag] = sum / variance;
        }

        let mut peaks: Vec<usize> = (min_lag + 1..max_lag)
            .filter(|lag| {
                autocorrelation[*lag] > autocorrelation[*lag - 1]
                    && autocorrelation[*lag] >= autocorrelation[*lag + 1]
            })
            .collect();
        if peaks.is_empty() {
            return None;
        }
        peaks.sort_by(|left, right| autocorrelation[*right].total_cmp(&autocorrelation[*left]));
        peaks.truncate(6);

        let mut candidates: Vec<TempoEstimate> = Vec::new();
        for peak in peaks {
            let lag = refine_lag(&autocorrelation, peak);
            let base_bpm = 60.0 / (lag * FRAME_SECONDS);
            for multiplier in [0.5f32, 1.0, 2.0] {
                let bpm = base_bpm * multiplier;
                if !(MIN_BPM..=MAX_BPM).contains(&bpm) {
                    continue;
                }
                if candidates
                    .iter()
                    .any(|candidate| (candidate.bpm - bpm).abs() < 0.6)
                {
                    continue;
                }
                let period = 60.0 / (bpm * FRAME_SECONDS);
                if period < 2.0 {
                    continue;
                }
                let Some(grid) = grid_info(&values, period) else {
                    continue;
                };
                let mut comb = 0.0f32;
                for multiple in 1..=4 {
                    let index = (period * multiple as f32).round() as usize;
                    if index < autocorrelation.len() {
                        comb += autocorrelation[index].max(0.0) / multiple as f32;
                    }
                }
                let prior = (-0.5 * ((bpm / 118.0).log2() / 0.7).powi(2)).exp();
                let offbeat_penalty = (grid.offbeat - 0.55).max(0.0) * 1.2;
                let score = 0.30 * comb
                    + 0.22 * grid.cover
                    + 0.18 * grid.occupancy
                    + 0.18 * grid.regularity
                    + 0.12 * prior
                    - offbeat_penalty;
                let period_frames = period.round() as usize;
                let pulse = autocorrelation
                    .get(period_frames)
                    .copied()
                    .unwrap_or(0.0)
                    .max(0.0);
                candidates.push(TempoEstimate {
                    bpm,
                    confidence: comb.clamp(0.0, 1.0),
                    pulse,
                    cover: grid.cover,
                    phase: grid.phase,
                    score,
                    occupancy: grid.occupancy,
                    regularity: grid.regularity,
                });
            }
        }
        let mut best = *candidates.iter().max_by(|left, right| {
            left.score
                .total_cmp(&right.score)
                .then_with(|| left.confidence.total_cmp(&right.confidence))
        })?;

        // 半拍/双拍是节奏周期检测的固有歧义。这里沿用原型 `recommendTempoMode` 的
        // 取向：≥140 BPM 时若半拍候选（65–105）确实有稳定起音，就采用半拍；
        // 慢速时只有另半拍真的每一拍都有起音才加倍，避免把真正的 60 BPM 翻成 120。
        let half_target = best.bpm * 0.5;
        if best.bpm >= 140.0 && (65.0..=105.0).contains(&half_target) {
            if let Some(half) = candidates.iter().find(|candidate| {
                (candidate.bpm - half_target).abs() / half_target < 0.04
                    && candidate.occupancy >= 0.8
                    && candidate.regularity >= 0.5
            }) {
                best = *half;
            }
        }
        let double_target = best.bpm * 2.0;
        if best.bpm <= 62.0 && (85.0..=140.0).contains(&double_target) {
            if let Some(doubled) = candidates.iter().find(|candidate| {
                (candidate.bpm - double_target).abs() / double_target < 0.04
                    && candidate.occupancy >= 0.8
                    && candidate.regularity >= 0.5
            }) {
                best = *doubled;
            }
        }
        Some(best)
    }

    fn apply_tempo(&mut self, estimate: &TempoEstimate) -> bool {
        let previous = self.bpm;
        if previous > 0.0 && (estimate.bpm - previous).abs() / previous.max(1.0) > BPM_SWITCH_RATIO
        {
            if (estimate.bpm - self.pending_bpm).abs() <= BPM_SWITCH_RATIO * estimate.bpm.max(1.0) {
                self.pending_bpm_count = self.pending_bpm_count.saturating_add(1);
            } else {
                self.pending_bpm = estimate.bpm;
                self.pending_bpm_count = 1;
            }
            if self.pending_bpm_count < BPM_SWITCH_CONFIRM {
                return false;
            }
        } else {
            self.pending_bpm = 0.0;
            self.pending_bpm_count = 0;
        }
        self.bpm = estimate.bpm;
        self.bpm_confidence = estimate.confidence;
        self.retime_beats(estimate);
        true
    }

    fn retime_beats(&mut self, estimate: &TempoEstimate) {
        let period = 60.0 / estimate.bpm.max(1.0) as f64;
        if period <= 0.0 || self.ose.is_empty() {
            return;
        }
        let window_start = self.clock - self.ose.len() as f64 * FRAME_SECONDS as f64;
        let anchor = window_start + estimate.phase as f64 * FRAME_SECONDS as f64;
        self.beat_period = period;
        let elapsed = (self.clock - anchor).max(0.0);
        let mut next = anchor + (elapsed / period).floor().max(0.0).mul_add(period, period);
        if next <= self.clock {
            next += period;
        }
        self.next_beat = next;
    }

    fn update_music(&mut self, estimate: &TempoEstimate) {
        // 占空比只看最近 1 秒：音乐停下后要尽快退出，不能被 6 秒窗口里的旧声音拖住。
        let recent_frames = (1.0 / FRAME_SECONDS) as usize;
        let recent: Vec<f32> = self
            .rms_history
            .iter()
            .rev()
            .take(recent_frames)
            .copied()
            .collect();
        let loud = recent.iter().filter(|value| **value > LOUD_RMS).count() as f32
            / recent.len().max(1) as f32;
        let bass_ratio = self.bass_ratio_history.iter().sum::<f32>()
            / self.bass_ratio_history.len().max(1) as f32;
        let pulse_score = ((estimate.pulse - 0.18) / 0.45).clamp(0.0, 1.0);
        let cover_score = ((estimate.cover - 0.18) / 0.45).clamp(0.0, 1.0);
        let bass_score = ((bass_ratio - 0.08) / 0.30).clamp(0.0, 1.0);
        // 游戏音效 / 单次提示音很“有节奏”，但中间大量静音：用占空比门限挡掉。
        let duty_gate = ((loud - 0.20) / 0.30).clamp(0.0, 1.0);
        // 人声通常既没有低频、也没有强拍；独奏/清唱靠“强拍”这一条豁免。
        // 没有这条惩罚时，音节节奏整齐的语音也能拿到 0.2–0.3 分。
        let weak_bass_penalty = if bass_ratio < 0.08 && estimate.pulse < 0.45 {
            0.10
        } else {
            0.0
        };
        let rhythm_score = ((0.50 * pulse_score + 0.35 * cover_score + 0.15 * bass_score)
            * duty_gate
            - weak_bass_penalty)
            .max(0.0);

        // 慢歌/抒情歌可能没有明显的鼓点，但音色仍是“音乐”：过零率低、频谱重心低、频谱平坦度低。
        // 语音的清辅音和共振峰会把这三项拉高，所以这个通道对普通说话不敏感。
        let zcr = history_mean(&self.zcr_history);
        let centroid = history_mean(&self.centroid_history);
        let flatness = history_mean(&self.flatness_history);
        let texture = texture_score(zcr, centroid, flatness) * 0.85 * duty_gate;
        let score = rhythm_score.max(texture);
        self.music_score = score;

        if score >= self.tuning.enter_score {
            self.music_enter_seconds += TEMPO_UPDATE_SECONDS as f32;
            if self.music || self.music_enter_seconds >= MUSIC_ENTER_HOLD_SECONDS {
                self.music = true;
                self.music_exit_seconds = 0.0;
            }
        } else if score <= self.tuning.exit_score {
            self.music_enter_seconds = 0.0;
            self.music_exit_seconds += TEMPO_UPDATE_SECONDS as f32;
            if self.music_exit_seconds >= MUSIC_EXIT_HOLD_SECONDS {
                self.music = false;
            }
        } else {
            self.music_enter_seconds = 0.0;
            self.music_exit_seconds = 0.0;
        }

        // 靠音色而不是靠鼓点认出来的慢歌，速度估计通常不可信；让前端按 96 的备用拍摇摆。
        // 但这个判定是贴着门限逐帧算的，会一帧可信一帧不可信，所以收回 BPM 也要驻留：
        // 连续 TEMPO_DOWNGRADE_HOLD_SECONDS 都不可信才清空，避免界面上的 BPM 时有时无。
        let tempo_unreliable =
            texture > rhythm_score && (estimate.pulse < 0.35 || estimate.confidence < 0.60);
        if !self.music {
            self.bpm = 0.0;
            self.bpm_confidence = 0.0;
            self.tempo_downgrade_seconds = 0.0;
        } else if tempo_unreliable {
            self.tempo_downgrade_seconds += TEMPO_UPDATE_SECONDS as f32;
            if self.tempo_downgrade_seconds >= TEMPO_DOWNGRADE_HOLD_SECONDS {
                self.bpm = 0.0;
                self.bpm_confidence = 0.0;
            }
        } else {
            self.tempo_downgrade_seconds = 0.0;
        }
    }

    fn emit_beat_if_due(&mut self, events: &mut Vec<AnalysisEvent>) {
        if !self.active || !self.music || self.bpm <= 0.0 || self.beat_period <= 0.0 {
            return;
        }
        if self.next_beat <= self.clock {
            if self.next_beat <= 0.0 {
                self.next_beat = self.clock + self.beat_period;
            }
            let mut guard = 0;
            while self.clock >= self.next_beat && guard < 2 {
                if self.clock - self.last_beat_emitted >= self.beat_period * 0.5 {
                    events.push(AnalysisEvent::Beat);
                    self.last_beat_emitted = self.clock;
                }
                self.next_beat += self.beat_period;
                guard += 1;
            }
            if self.next_beat < self.clock - self.beat_period {
                self.next_beat = self.clock + self.beat_period;
            }
        }
    }

    fn reset_music_state(&mut self) {
        self.music = false;
        self.music_score = 0.0;
        self.music_enter_seconds = 0.0;
        self.music_exit_seconds = 0.0;
        self.bpm = 0.0;
        self.bpm_confidence = 0.0;
        self.tempo_downgrade_seconds = 0.0;
        self.pending_bpm = 0.0;
        self.pending_bpm_count = 0;
        self.beat_period = 0.0;
        self.next_beat = 0.0;
    }

    fn reset_analysis_history(&mut self) {
        self.reset_music_state();
        self.ose.clear();
        self.rms_history.clear();
        self.bass_ratio_history.clear();
        self.zcr_history.clear();
        self.centroid_history.clear();
        self.flatness_history.clear();
        self.ose_band_log.fill(0.0);
        self.ose_highpass = 0.0;
        self.last_tempo_at = f64::NEG_INFINITY;
        self.last_beat_emitted = f64::NEG_INFINITY;
    }

    #[cfg(test)]
    fn is_active(&self) -> bool {
        self.active
    }

    #[cfg(test)]
    fn is_music(&self) -> bool {
        self.music
    }

    #[cfg(test)]
    fn music_score(&self) -> f32 {
        self.music_score
    }
}

fn push_bounded(buffer: &mut VecDeque<f32>, value: f32) {
    if buffer.len() >= MAX_HISTORY_FRAMES {
        buffer.pop_front();
    }
    buffer.push_back(value);
}

fn history_mean(history: &VecDeque<f32>) -> f32 {
    if history.is_empty() {
        return 0.0;
    }
    history.iter().sum::<f32>() / history.len() as f32
}

/// 与节拍无关的“音色像不像音乐”评分：语音的清辅音/共振峰会同时拉高过零率与频谱重心。
fn texture_score(zcr: f32, centroid: f32, flatness: f32) -> f32 {
    let zcr_score = ((0.045 - zcr) / (0.045 - 0.018)).clamp(0.0, 1.0);
    let centroid_score = ((1500.0 - centroid) / (1500.0 - 700.0)).clamp(0.0, 1.0);
    let flatness_score = ((0.030 - flatness) / (0.030 - 0.008)).clamp(0.0, 1.0);
    0.45 * zcr_score + 0.35 * centroid_score + 0.20 * flatness_score
}

/// 用抛物线插值把自相关峰细化到小数帧。
fn refine_lag(autocorrelation: &[f32], peak: usize) -> f32 {
    let left = autocorrelation[peak - 1];
    let center = autocorrelation[peak];
    let right = autocorrelation[peak + 1];
    let denominator = left - 2.0 * center + right;
    if denominator.abs() > 1e-9 {
        peak as f32 + 0.5 * (left - right) / denominator
    } else {
        peak as f32
    }
}

/// 对候选拍长寻找最佳相位，并返回网格覆盖率、占空比与强弱规整度。
fn grid_info(values: &[f32], period: f32) -> Option<GridInfo> {
    let total: f32 = values.iter().sum();
    if total <= 1e-9 || period < 2.0 {
        return None;
    }
    let max_value = values.iter().copied().fold(0.0f32, f32::max);
    if max_value <= 1e-9 {
        return None;
    }
    let occupancy_threshold = max_value * 0.12;
    let phase_count = period.ceil().max(1.0) as usize;
    let local_strength = |index: usize| {
        let low = index.saturating_sub(1);
        let high = (index + 1).min(values.len() - 1);
        values[low..=high].iter().copied().fold(0.0f32, f32::max)
    };
    let mut best_hit = -1.0f32;
    let mut best_phase = 0.0f32;
    for phase in 0..phase_count {
        let mut hit = 0.0f32;
        let mut position = phase as f32;
        while position < values.len() as f32 {
            let index = position.round() as usize;
            if index < values.len() {
                hit += local_strength(index);
            }
            position += period;
        }
        if hit > best_hit {
            best_hit = hit;
            best_phase = phase as f32;
        }
    }
    if best_hit <= 0.0 {
        return None;
    }

    let mut grid_values = Vec::new();
    let mut cover = 0.0f32;
    let mut position = best_phase;
    while position < values.len() as f32 {
        let index = position.round() as usize;
        if index < values.len() {
            grid_values.push(local_strength(index));
            let low = index.saturating_sub(1);
            let high = (index + 1).min(values.len() - 1);
            cover += values[low..=high].iter().sum::<f32>();
        }
        position += period;
    }
    if grid_values.is_empty() {
        return None;
    }
    let occupied = grid_values
        .iter()
        .filter(|value| **value > occupancy_threshold)
        .count();
    let occupancy = occupied as f32 / grid_values.len() as f32;

    let beat_mean = grid_values.iter().sum::<f32>() / grid_values.len() as f32;
    let variance = grid_values
        .iter()
        .map(|value| (value - beat_mean).powi(2))
        .sum::<f32>()
        / grid_values.len() as f32;
    let regularity = if beat_mean > 1e-9 {
        (1.0 - variance.sqrt() / beat_mean).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let mut offbeat_sum = 0.0f32;
    let mut offbeat_count = 0usize;
    let mut position = best_phase + period * 0.5;
    while position < values.len() as f32 {
        let index = position.round() as usize;
        if index < values.len() {
            offbeat_sum += values[index];
            offbeat_count += 1;
        }
        position += period;
    }
    let offbeat = if offbeat_count > 0 && beat_mean > 1e-9 {
        offbeat_sum / offbeat_count as f32 / beat_mean
    } else {
        1.0
    };
    Some(GridInfo {
        phase: best_phase,
        cover: (cover / total).clamp(0.0, 1.0),
        offbeat,
        occupancy,
        regularity,
    })
}

fn bin_range(hz_per_bin: f32, band: (f32, f32)) -> std::ops::Range<usize> {
    let start = (band.0 / hz_per_bin).floor().max(1.0) as usize;
    let end = (band.1 / hz_per_bin).ceil().max(2.0) as usize;
    start.max(1)..end.min(FFT_SIZE / 2 + 1).max(start + 1)
}

// ---------------------------------------------------------------------------
// Windows WASAPI 回环采集
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use std::{
        ffi::c_void,
        ptr::{null_mut, read_unaligned},
        slice,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc::Sender,
            Arc,
        },
        thread,
        time::Duration,
    };

    use tauri::AppHandle;
    use windows::core::GUID;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };

    use super::{emit_events, AudioFormat, Inner, MusicAnalyser, MusicTuning};

    const WAVE_FORMAT_PCM: u16 = 1;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
    const SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00aa00389b71);
    const SUBTYPE_FLOAT: GUID = GUID::from_u128(0x0000_0003_0000_0010_8000_00aa00389b71);

    struct ComGuard;

    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    unsafe fn read_format(format: *const WAVEFORMATEX) -> Result<AudioFormat, &'static str> {
        if format.is_null() {
            return Err("music_format_unsupported");
        }
        let base = read_unaligned(format);
        let mut float = match base.wFormatTag {
            WAVE_FORMAT_PCM => false,
            WAVE_FORMAT_IEEE_FLOAT => true,
            WAVE_FORMAT_EXTENSIBLE => false,
            _ => return Err("music_format_unsupported"),
        };
        if base.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
            let extended = read_unaligned(format as *const WAVEFORMATEXTENSIBLE);
            let subtype = extended.SubFormat;
            float = if subtype == SUBTYPE_FLOAT {
                true
            } else if subtype == SUBTYPE_PCM {
                false
            } else {
                return Err("music_format_unsupported");
            };
        }
        let channels = base.nChannels;
        let sample_rate = base.nSamplesPerSec;
        let bits = base.wBitsPerSample;
        let block_align = base.nBlockAlign;
        let sample_bytes = (bits / 8) as usize;
        if channels == 0
            || channels > 8
            || sample_rate < 8_000
            || !matches!(bits, 16 | 24 | 32)
            || (block_align as usize) < sample_bytes * channels as usize
        {
            return Err("music_format_unsupported");
        }
        Ok(AudioFormat {
            channels,
            sample_rate,
            block_align,
            bits,
            float,
        })
    }

    pub fn run(
        inner: Arc<Inner>,
        app: AppHandle,
        stop: Arc<AtomicBool>,
        generation: u64,
        ready: Sender<Result<(), &'static str>>,
        tuning: MusicTuning,
    ) {
        let result = capture_loop(&app, &inner, &stop, &ready, tuning);
        let current = inner.generation.load(Ordering::SeqCst) == generation;
        if let Err(code) = result {
            // 初始化成功后才失败时，start() 已经返回；前端靠 watchdog 与状态行收尾。
            let _ = ready.send(Err(code));
            if current {
                if let Ok(mut error) = inner.last_error.lock() {
                    *error = Some(code.to_string());
                }
                let _ = tauri::Emitter::emit(
                    &app,
                    "qiling-music-sense",
                    serde_json::json!({ "error": code }),
                );
            }
        }
        if current {
            inner.running.store(false, Ordering::SeqCst);
            if let Ok(mut session) = inner.session_stop.lock() {
                *session = None;
            }
        }
    }

    fn capture_loop(
        app: &AppHandle,
        inner: &Inner,
        stop: &AtomicBool,
        ready: &Sender<Result<(), &'static str>>,
        tuning: MusicTuning,
    ) -> Result<(), &'static str> {
        unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                let _ = ready.send(Err("music_start_failed"));
                return Err("music_start_failed");
            }
            let _com = ComGuard;

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|_| "music_unavailable")?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|_| "music_unavailable")?;
            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|_| "music_start_failed")?;
            let mix = client
                .GetMixFormat()
                .map_err(|_| "music_format_unsupported")?;
            let format = read_format(mix);
            let format = match format {
                Ok(format) => format,
                Err(code) => {
                    CoTaskMemFree(Some(mix as *const c_void));
                    let _ = ready.send(Err(code));
                    return Err(code);
                }
            };
            // 1 秒缓冲足够覆盖 10ms 轮询；共享模式要求 periodicity = 0。
            let initialized = client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                10_000_000,
                0,
                mix,
                None,
            );
            CoTaskMemFree(Some(mix as *const c_void));
            if initialized.is_err() {
                let _ = ready.send(Err("music_start_failed"));
                return Err("music_start_failed");
            }
            let capture: IAudioCaptureClient =
                client.GetService().map_err(|_| "music_start_failed")?;
            if client.Start().is_err() {
                let _ = ready.send(Err("music_start_failed"));
                return Err("music_start_failed");
            }

            let _ = ready.send(Ok(()));
            let mut analyser = MusicAnalyser::new(format.sample_rate);
            analyser.set_tuning(tuning);
            let mut applied_tuning = tuning;
            let mut decoded: Vec<f32> = Vec::new();

            while !stop.load(Ordering::Relaxed) {
                // 设定页可能随时改阈值；只在变化时写入分析器，避免每包重复加锁。
                if let Ok(current) = inner.tuning.lock() {
                    if *current != applied_tuning {
                        applied_tuning = *current;
                        analyser.set_tuning(applied_tuning);
                    }
                }
                let mut packets = 0;
                loop {
                    let frames = match capture.GetNextPacketSize() {
                        Ok(frames) => frames,
                        Err(_) => {
                            let _ = client.Stop();
                            return Err("music_capture_failed");
                        }
                    };
                    if frames == 0 {
                        break;
                    }
                    packets += 1;
                    let mut data: *mut u8 = null_mut();
                    let mut frames_available = 0u32;
                    let mut flags = 0u32;
                    if capture
                        .GetBuffer(&mut data, &mut frames_available, &mut flags, None, None)
                        .is_err()
                    {
                        let _ = client.Stop();
                        return Err("music_capture_failed");
                    }
                    let events =
                        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                            analyser.push_zeros(frames_available as usize)
                        } else {
                            let bytes = slice::from_raw_parts(
                                data,
                                frames_available as usize * format.block_align as usize,
                            );
                            match format.decode(bytes, &mut decoded) {
                                Ok(()) => analyser.push(&decoded),
                                Err(code) => {
                                    let _ = capture.ReleaseBuffer(frames_available);
                                    let _ = client.Stop();
                                    return Err(code);
                                }
                            }
                        };
                    if capture.ReleaseBuffer(frames_available).is_err() {
                        let _ = client.Stop();
                        return Err("music_capture_failed");
                    }
                    emit_events(app, inner, events);
                }
                if packets == 0 {
                    thread::sleep(Duration::from_millis(8));
                }
            }
            let _ = client.Stop();
            Ok(())
        }
    }
}
#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    fn format(bits: u16, float: bool, channels: u16) -> AudioFormat {
        AudioFormat {
            channels,
            sample_rate: 48_000,
            block_align: channels * (bits / 8),
            bits,
            float,
        }
    }

    #[test]
    fn fft_finds_a_single_bin() {
        let fft = Fft::new(FFT_SIZE);
        let bin = 100;
        let mut re = vec![0.0f32; FFT_SIZE];
        let mut im = vec![0.0f32; FFT_SIZE];
        for (index, value) in re.iter_mut().enumerate() {
            *value =
                (2.0 * std::f32::consts::PI * bin as f32 * index as f32 / FFT_SIZE as f32).sin();
        }
        fft.transform(&mut re, &mut im);
        let magnitude = (re[bin] * re[bin] + im[bin] * im[bin]).sqrt();
        assert!(
            (magnitude - FFT_SIZE as f32 / 2.0).abs() < 1.0,
            "{magnitude}"
        );
        let neighbour = (re[bin + 1] * re[bin + 1] + im[bin + 1] * im[bin + 1]).sqrt();
        assert!(neighbour < magnitude / 10.0);
    }

    #[test]
    fn decodes_pcm16_stereo_by_downmixing() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&16_384i16.to_le_bytes());
        bytes.extend_from_slice(&(-16_384i16).to_le_bytes());
        let mut out = Vec::new();
        format(16, false, 2).decode(&bytes, &mut out).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].abs() < 1e-6);
    }

    #[test]
    fn decodes_24_bit_and_float() {
        let mut out = Vec::new();
        format(24, false, 1)
            .decode(&[0xFF, 0xFF, 0x7F], &mut out)
            .unwrap();
        assert!((out[0] - 1.0).abs() < 1e-6);
        format(24, false, 1)
            .decode(&[0x00, 0x00, 0x80], &mut out)
            .unwrap();
        assert!((out[0] + 1.0).abs() < 1e-6);

        let mut float_bytes = Vec::new();
        float_bytes.extend_from_slice(&0.25f32.to_le_bytes());
        format(32, true, 1).decode(&float_bytes, &mut out).unwrap();
        assert!((out[0] - 0.25).abs() < 1e-6);

        assert_eq!(
            format(8, false, 1).decode(&[0], &mut out),
            Err("music_format_unsupported")
        );
    }

    #[test]
    fn normalisation_matches_the_prototype_window() {
        assert_eq!(normalize_db(0.0), 0.0);
        assert_eq!(normalize_db(1e-5), 0.0);
        // −69 dB 偏移后，满刻度附近的幅度会落到窗口上沿。
        assert_eq!(normalize_db(1000.0), 1.0);
    }

    fn tone(amplitude: f32, seconds: f32, hz: f32) -> Vec<f32> {
        let rate = 48_000usize;
        let total = (rate as f32 * seconds) as usize;
        (0..total)
            .map(|index| {
                (2.0 * std::f32::consts::PI * hz * index as f32 / rate as f32).sin() * amplitude
            })
            .collect()
    }

    fn feed(analyser: &mut MusicAnalyser, samples: &[f32]) -> Vec<AnalysisEvent> {
        let mut events = Vec::new();
        for chunk in samples.chunks(512) {
            events.extend(analyser.push(chunk));
        }
        events
    }

    fn last_snapshot(events: &[AnalysisEvent]) -> MusicSnapshot {
        events
            .iter()
            .rev()
            .find_map(|event| match event {
                AnalysisEvent::Sense(snapshot) => Some(*snapshot),
                _ => None,
            })
            .expect("sense event")
    }

    fn beat_count(events: &[AnalysisEvent]) -> usize {
        events
            .iter()
            .filter(|event| matches!(event, AnalysisEvent::Beat))
            .count()
    }

    /// 合成节拍音轨：每拍一个低频脉冲；`offbeats` 为 true 时加反拍踩镲。
    /// 底下垫一层很轻的持续低音，模拟真实音乐在鼓点之间也有声压（否则存在判定会反复清零）。
    fn click_track(bpm: f32, seconds: f32, offbeats: bool) -> Vec<f32> {
        let rate = 48_000usize;
        let total = (rate as f32 * seconds) as usize;
        let beat = 60.0 / bpm;
        let mut samples: Vec<f32> = (0..total)
            .map(|index| {
                (2.0 * std::f32::consts::PI * 110.0 * index as f32 / rate as f32).sin() * 0.012
            })
            .collect();
        let mut position = 0.0f32;
        while position < seconds - 0.05 {
            add_kick(&mut samples, (position * rate as f32) as usize, rate);
            if offbeats {
                add_hat(
                    &mut samples,
                    ((position + beat * 0.5) * rate as f32) as usize,
                    rate,
                );
            }
            position += beat;
        }
        samples
    }

    fn add_kick(samples: &mut [f32], start: usize, rate: usize) {
        let length = (rate as f32 * 0.24) as usize;
        for index in 0..length {
            let t = index as f32 / rate as f32;
            let frequency = 120.0 * (-t * 28.0).exp() + 45.0;
            let amplitude = (-t / 0.09).exp() * 0.85;
            let value = (2.0 * std::f32::consts::PI * frequency * t).sin() * amplitude;
            if let Some(sample) = samples.get_mut(start + index) {
                *sample += value;
            }
        }
    }

    fn add_hat(samples: &mut [f32], start: usize, rate: usize) {
        let length = (rate as f32 * 0.05) as usize;
        let mut noise = 0.371_234_56f32;
        for index in 0..length {
            noise = (noise * 1_103_515.456_9 + 12_345.0).fract();
            let t = index as f32 / rate as f32;
            let value = (noise * 2.0 - 1.0) * (-t / 0.015).exp() * 0.18;
            if let Some(sample) = samples.get_mut(start + index) {
                *sample += value;
            }
        }
    }

    /// 合成“慢歌”：持续和弦 + 稀疏旋律，没有鼓点；用来守住音色通道。
    fn soft_ballad(seconds: f32) -> Vec<f32> {
        let rate = 48_000usize;
        let total = (rate as f32 * seconds) as usize;
        let mut samples = vec![0.0f32; total];
        let chords = [[220.0f32, 261.63, 329.63], [196.0, 246.94, 293.66]];
        let melody = [440.0f32, 523.25, 493.88, 392.0];
        let mut chord_index = 0usize;
        let mut position = 0.0f32;
        while position < seconds - 0.1 {
            let start = (position * rate as f32) as usize;
            let chord = chords[chord_index % chords.len()];
            for hz in chord {
                let duration = 2.0f32.min(seconds - position);
                let length = (duration * rate as f32) as usize;
                for index in 0..length {
                    let t = index as f32 / rate as f32;
                    let attack = (t / 0.15).min(1.0);
                    let value = (2.0 * std::f32::consts::PI * hz * t).sin() * attack * 0.06;
                    if let Some(sample) = samples.get_mut(start + index) {
                        *sample += value;
                    }
                }
            }
            chord_index += 1;
            position += 2.0;
        }
        let mut position = 0.0f32;
        let mut note_index = 0usize;
        while position < seconds - 0.1 {
            let start = (position * rate as f32) as usize;
            let hz = melody[note_index % melody.len()];
            let length = (0.8 * rate as f32) as usize;
            for index in 0..length {
                let t = index as f32 / rate as f32;
                let envelope = (t / 0.05).min(1.0) * (-t / 0.6).exp();
                let value = (2.0 * std::f32::consts::PI * hz * t).sin() * envelope * 0.05;
                if let Some(sample) = samples.get_mut(start + index) {
                    *sample += value;
                }
            }
            note_index += 1;
            position += 1.0;
        }
        samples
    }

    /// 合成“像说话”的信号：不规则音节、滑动的基频、少量清音噪声。
    fn speech_like(seconds: f32) -> Vec<f32> {
        let rate = 48_000usize;
        let total = (rate as f32 * seconds) as usize;
        // 用低电平宽带底噪模拟房间声，让监听保持激活，又不会像 60Hz 垫音那样伪造低频。
        let mut pad_seed = 0x0bad_f00du32;
        let mut samples: Vec<f32> = (0..total)
            .map(|_| {
                pad_seed = pad_seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((pad_seed >> 8) as f32 / 16_777_216.0 - 0.5) * 0.004
            })
            .collect();
        let mut seed = 0x1234_5678u32;
        let mut random = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / 16_777_216.0
        };
        let mut position = 0.15f32;
        while position < seconds - 0.2 {
            let duration = 0.08 + random() * 0.18;
            let base = 110.0 + random() * 100.0;
            let start = (position * rate as f32) as usize;
            let length = (duration * rate as f32) as usize;
            for index in 0..length {
                let t = index as f32 / rate as f32;
                // 更明显的滑动基频和抖动，避免听起来像稳定的“唱”而不是“说”。
                let glide = base * (1.0 - 0.35 * t / duration) * (1.0 + 0.02 * (t * 37.0).sin());
                let syllable = (std::f32::consts::PI * t / duration).sin();
                let mut value = 0.0;
                for harmonic in 1..=5 {
                    value += (2.0 * std::f32::consts::PI * glide * harmonic as f32 * t).sin()
                        / harmonic as f32;
                }
                let value = value * syllable * 0.16;
                if let Some(sample) = samples.get_mut(start + index) {
                    *sample += value;
                }
            }
            // 音节开头加一点清辅音噪声。
            let noise_length = ((0.02 + random() * 0.02) * rate as f32) as usize;
            for index in 0..noise_length {
                if let Some(sample) = samples.get_mut(start + index) {
                    *sample += (random() - 0.5) * 0.12;
                }
            }
            position += duration + 0.05 + random() * 0.45;
            if random() < 0.3 {
                // 像真实说话一样偶尔停顿一整句，打散“音节节拍”。
                position += 0.6 + random() * 1.6;
            }
        }
        samples
    }

    fn white_noise(seconds: f32) -> Vec<f32> {
        let total = (48_000f32 * seconds) as usize;
        let mut seed = 0x9e37_79b9u32;
        (0..total)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((seed >> 8) as f32 / 16_777_216.0 - 0.5) * 0.1
            })
            .collect()
    }

    #[test]
    fn activates_on_a_sustained_tone_and_stops_after_silence() {
        let mut analyser = MusicAnalyser::new(48_000);
        let events = feed(&mut analyser, &tone(0.4, 2.0, 80.0));
        let last = events
            .iter()
            .rev()
            .find_map(|event| match event {
                AnalysisEvent::Sense(snapshot) => Some(*snapshot),
                _ => None,
            })
            .expect("sense event");
        assert!(last.active);
        assert!(last.energy > 0.2, "{}", last.energy);

        let events = feed(&mut analyser, &vec![0.0; 48_000 * 5]);
        let last = events
            .iter()
            .rev()
            .find_map(|event| match event {
                AnalysisEvent::Sense(snapshot) => Some(*snapshot),
                _ => None,
            })
            .unwrap();
        assert!(!last.active);
        assert_eq!(last.energy <= 0.2, true);
        assert!(!analyser.is_active());
    }

    #[test]
    fn quiet_audio_does_not_start_listening() {
        let mut analyser = MusicAnalyser::new(48_000);
        let events = feed(&mut analyser, &tone(0.0003, 3.0, 80.0));
        assert!(events.iter().all(|event| match event {
            AnalysisEvent::Sense(snapshot) => !snapshot.active,
            _ => true,
        }));
        assert!(!analyser.is_active());
    }

    #[test]
    fn detects_onsets_and_estimates_the_bpm() {
        let rate = 48_000usize;
        let mut samples = Vec::with_capacity(rate * 8);
        for index in 0..rate * 8 {
            let t = index as f32 / rate as f32;
            let amplitude = if t % 0.5 < 0.06 { 0.9 } else { 0.3 };
            samples.push((2.0 * std::f32::consts::PI * 80.0 * t).sin() * amplitude);
        }
        let mut analyser = MusicAnalyser::new(rate as u32);
        let events = feed(&mut analyser, &samples);
        let beats = events
            .iter()
            .filter(|event| matches!(event, AnalysisEvent::Beat))
            .count();
        assert!(beats >= 6, "beats: {beats}");
        let last = events
            .iter()
            .rev()
            .find_map(|event| match event {
                AnalysisEvent::Sense(snapshot) => Some(*snapshot),
                _ => None,
            })
            .unwrap();
        assert!(last.active);
        assert!((100.0..=140.0).contains(&last.bpm), "bpm: {}", last.bpm);
    }

    /// 用仓库里的 120 BPM 测试音频对照原型标定：中位能量应稳定落在「激烈」，
    /// 且鼓点估出的 BPM 接近 120。这条测试同时守住 FFT 与 dB 偏移。
    #[test]
    fn matches_the_prototype_on_the_bundled_120_bpm_track() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../design/characters/lingpao/_workshop/test-120bpm.wav");
        let Some((samples, rate)) = read_wav(&path) else {
            return;
        };
        let mut analyser = MusicAnalyser::new(rate);
        let events = feed(&mut analyser, &samples);
        let snapshots: Vec<MusicSnapshot> = events
            .iter()
            .filter_map(|event| match event {
                AnalysisEvent::Sense(snapshot) => Some(*snapshot),
                _ => None,
            })
            .collect();
        assert!(snapshots.len() > 100);
        let early = snapshots.get(20).copied().unwrap();
        assert!(early.active);
        assert!(early.energy > 0.6, "energy after 1s: {}", early.energy);
        let tail: Vec<f32> = snapshots
            .iter()
            .skip(40)
            .map(|snapshot| snapshot.energy)
            .collect();
        let mut sorted = tail.clone();
        sorted.sort_by(|left, right| left.total_cmp(right));
        let median = sorted[sorted.len() / 2];
        assert!(median > 0.85, "median energy: {median}");
        let peak = tail.iter().copied().fold(0.0f32, f32::max);
        assert!(peak > 0.9, "peak energy: {peak}");
        let last = snapshots.last().copied().unwrap();
        assert!(last.active);
        assert!(last.music);
        assert!((110.0..=130.0).contains(&last.bpm), "bpm: {}", last.bpm);
        assert!(last.bpm_confidence > 0.5, "{}", last.bpm_confidence);
    }

    /// 60 BPM 原来落在 70 BPM 下限之外，会被当成“没估出速度”。
    #[test]
    fn accepts_a_half_tempo_track_below_the_old_bpm_floor() {
        let events = feed(
            &mut MusicAnalyser::new(48_000),
            &click_track(60.0, 12.0, false),
        );
        let last = last_snapshot(&events);
        assert!(last.active);
        assert!(last.music, "score: {}", last.music);
        assert!((57.0..=63.0).contains(&last.bpm), "bpm: {}", last.bpm);
        assert!(beat_count(&events) >= 5, "beats: {}", beat_count(&events));
    }

    /// 反拍踩镲是八分音符，不应把 120 BPM 推成 240，也不应退成 60。
    #[test]
    fn keeps_the_beat_when_offbeat_hats_add_eighth_note_pulses() {
        let events = feed(
            &mut MusicAnalyser::new(48_000),
            &click_track(120.0, 12.0, true),
        );
        let last = last_snapshot(&events);
        assert!(last.music);
        assert!((116.0..=124.0).contains(&last.bpm), "bpm: {}", last.bpm);
        assert!(beat_count(&events) >= 10);
    }

    /// 90 BPM 歌里每拍一个八分音符踩镲时，算法容易报 180；应按原型的取向回到半拍。
    #[test]
    fn folds_eighth_note_pulses_back_to_the_perceived_half_beat() {
        let events = feed(
            &mut MusicAnalyser::new(48_000),
            &click_track(90.0, 12.0, true),
        );
        let last = last_snapshot(&events);
        assert!(last.music);
        assert!((85.0..=95.0).contains(&last.bpm), "bpm: {}", last.bpm);
    }

    /// 人声（含静音垫底、足够响到激活监听）不能被当成音乐，也不应打出鼓点。
    #[test]
    fn does_not_treat_speech_as_music() {
        let mut analyser = MusicAnalyser::new(48_000);
        let events = feed(&mut analyser, &speech_like(12.0));
        let last = last_snapshot(&events);
        assert!(last.active);
        assert!(!last.music, "score: {}", analyser.music_score());
        assert!(!analyser.is_music());
        assert_eq!(beat_count(&events), 0);
    }
    /// 白噪声同样只有能量、没有节拍。
    #[test]
    fn does_not_treat_noise_as_music() {
        let mut analyser = MusicAnalyser::new(48_000);
        let events = feed(&mut analyser, &white_noise(10.0));
        let last = last_snapshot(&events);
        assert!(last.active);
        assert!(!last.music);
        assert_eq!(beat_count(&events), 0);
    }

    /// 抒情慢歌没有明显鼓点，但音色是音乐；不能因为节拍弱就完全不跟。
    #[test]
    fn accepts_soft_music_without_a_strong_beat() {
        let mut analyser = MusicAnalyser::new(48_000);
        let events = feed(&mut analyser, &soft_ballad(12.0));
        let last = last_snapshot(&events);
        assert!(last.active);
        assert!(last.music, "score: {}", analyser.music_score());
    }

    /// 设定页把进入阈值调高后，同一段音乐不应再被判成音乐。
    #[test]
    fn custom_thresholds_can_suppress_music_detection() {
        let mut analyser = MusicAnalyser::new(48_000);
        analyser.set_tuning(MusicTuning {
            enter_score: 0.99,
            exit_score: 0.98,
        });
        let events = feed(&mut analyser, &click_track(120.0, 12.0, true));
        let last = last_snapshot(&events);
        assert!(last.active);
        assert!(!last.music, "score: {}", analyser.music_score());
        assert_eq!(last.bpm, 0.0);
        assert_eq!(beat_count(&events), 0);
    }

    /// 速度“不可信”要连续 1 秒才把 BPM 收回 0；单帧置信度掉下去不能让界面闪断。
    #[test]
    fn holds_the_bpm_for_a_second_before_the_texture_fallback() {
        let mut analyser = MusicAnalyser::new(48_000);
        analyser.music = true;
        analyser.bpm = 120.0;
        analyser.bpm_confidence = 0.9;
        // 音色像音乐、节奏证据很弱：让 update_music 走到“速度不可信”的分支。
        for _ in 0..100 {
            push_bounded(&mut analyser.rms_history, 0.05);
            push_bounded(&mut analyser.zcr_history, 0.001);
            push_bounded(&mut analyser.centroid_history, 300.0);
            push_bounded(&mut analyser.flatness_history, 0.001);
        }
        let unreliable = TempoEstimate {
            bpm: 120.0,
            confidence: 0.4,
            pulse: 0.2,
            cover: 0.2,
            phase: 0.0,
            score: 0.2,
            occupancy: 0.2,
            regularity: 0.2,
        };
        analyser.update_music(&unreliable);
        assert_eq!(analyser.bpm, 120.0, "第一帧就收回会让界面闪断");
        analyser.update_music(&unreliable);
        assert_eq!(analyser.bpm, 0.0, "连续 1 秒不可信后应改走 96 备用拍");
    }

    /// 设定页发来的 JSON 用 camelCase；缺字段时用原型默认值补全。
    #[test]
    fn deserializes_user_tuning_with_camel_case_and_defaults() {
        let tuning: MusicTuning =
            serde_json::from_str(r#"{"enterScore":0.4,"exitScore":0.25}"#).unwrap();
        assert_eq!(
            tuning,
            MusicTuning {
                enter_score: 0.4,
                exit_score: 0.25,
            }
        );

        let partial: MusicTuning = serde_json::from_str(r#"{"enterScore":0.4}"#).unwrap();
        assert_eq!(partial.enter_score, 0.4);
        assert_eq!(partial.exit_score, MUSIC_EXIT_SCORE);
    }

    /// 前端传入越界或 NaN 时也要收敛成可用的滞回区间，而不是让判定卡死。
    #[test]
    fn tuning_is_clamped_into_a_valid_hysteresis_band() {
        let high = MusicTuning {
            enter_score: 2.0,
            exit_score: 3.0,
        }
        .sanitized();
        assert!((high.enter_score - 0.95).abs() < 1e-6);
        assert!(high.exit_score < high.enter_score);

        let low = MusicTuning {
            enter_score: -1.0,
            exit_score: -1.0,
        }
        .sanitized();
        assert!((low.enter_score - MIN_TUNED_SCORE).abs() < 1e-6);
        assert!(low.exit_score < low.enter_score);

        let broken = MusicTuning {
            enter_score: f32::NAN,
            exit_score: f32::NAN,
        }
        .sanitized();
        assert_eq!(broken, MusicTuning::default());
    }

    /// 音乐停了要尽快退出音乐状态，而不是继续按旧节拍跳到 3.5s 静音判定。
    #[test]
    fn stops_following_shortly_after_the_music_stops() {
        let mut analyser = MusicAnalyser::new(48_000);
        let _ = feed(&mut analyser, &click_track(120.0, 8.0, true));
        assert!(analyser.is_music());

        let events = feed(&mut analyser, &vec![0.0; 48_000 * 2]);
        let last = last_snapshot(&events);
        assert!(last.active, "still inside the 3.5s stop window");
        assert!(!last.music, "score: {}", analyser.music_score());
        assert_eq!(last.bpm, 0.0);
    }

    fn read_wav(path: &PathBuf) -> Option<(Vec<f32>, u32)> {
        let bytes = fs::read(path).ok()?;
        if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return None;
        }
        let mut offset = 12;
        let mut channels = 0u16;
        let mut rate = 0u32;
        let mut bits = 0u16;
        let mut pcm = Vec::new();
        while offset + 8 <= bytes.len() {
            let id = &bytes[offset..offset + 4];
            let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
            let body = offset + 8;
            if body + size > bytes.len() {
                break;
            }
            if id == b"fmt " {
                channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
                rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().ok()?);
                bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
            } else if id == b"data" {
                pcm = bytes[body..body + size].to_vec();
            }
            offset = body + size + (size & 1);
        }
        if !matches!(channels, 1 | 2) || bits != 16 || pcm.is_empty() {
            return None;
        }
        let channels = channels as usize;
        let samples = pcm
            .chunks_exact(2 * channels)
            .map(|frame| {
                let mut sum = 0.0;
                for channel in 0..channels {
                    let offset = channel * 2;
                    sum += i16::from_le_bytes([frame[offset], frame[offset + 1]]) as f32 / 32_768.0;
                }
                sum / channels as f32
            })
            .collect();
        Some((samples, rate))
    }
}
