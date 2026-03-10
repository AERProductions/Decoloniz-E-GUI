import { useState, useCallback, useEffect, useRef } from 'react';
import './App.css';
import {
  SelectFiles,
  SelectFolder,
  AnalyzePitch,
  ConvertBatch,
  GetDetectors,
  GetSupportedFormats,
  GetEQPresets,
  PreviewFile,
  StatFiles,
} from '../wailsjs/go/main/App';
import { EventsOn, EventsOff, OnFileDrop } from '../wailsjs/runtime/runtime';

interface FileEntry {
  path: string;
  name: string;
  size: number;
  extension: string;
  detectedHz?: number;
  confidence?: number;
  warning?: string;
  status: 'pending' | 'analyzing' | 'ready' | 'converting' | 'done' | 'skipped' | 'error';
  error?: string;
  ratio?: number;
}

interface ConvertResult {
  inputPath: string;
  outputPath: string;
  detectedHz: number;
  confidence: number;
  targetHz: number;
  ratio: number;
  skipped: boolean;
  warning?: string;
  error?: string;
}

function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [outputDir, setOutputDir] = useState('');
  const [targetHz, setTargetHz] = useState(432);
  const [threshold, setThreshold] = useState(0.5);
  const [tag, setTag] = useState('');
  const [detectorName, setDetectorName] = useState('fft');
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, currentFile: '' });
  const [summary, setSummary] = useState<{ converted: number; skipped: number; errors: number } | null>(null);

  // EQ state
  const [eqPreset, setEqPreset] = useState('Flat');
  const [eqBass, setEqBass] = useState(0);
  const [eqMid, setEqMid] = useState(0);
  const [eqTreble, setEqTreble] = useState(0);
  const [previewing, setPreviewing] = useState<string | null>(null);

  // Output format & quality
  const [outputFormat, setOutputFormat] = useState('original');
  const [quality, setQuality] = useState(6);
  const [sampleRate, setSampleRate] = useState(0);

  // Drag-and-drop state
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const eqPresets: Record<string, { bass: number; mid: number; treble: number }> = {
    Flat:   { bass: 0, mid: 0, treble: 0 },
    Warm:   { bass: 3, mid: 0, treble: -2 },
    Deep:   { bass: 6, mid: -2, treble: -1 },
    Bright: { bass: -1, mid: 0, treble: 4 },
  };

  const applyPreset = (name: string) => {
    setEqPreset(name);
    if (name !== 'Custom') {
      const p = eqPresets[name] || eqPresets.Flat;
      setEqBass(p.bass);
      setEqMid(p.mid);
      setEqTreble(p.treble);
    }
  };

  // --- Drag and Drop via Wails native ---
  useEffect(() => {
    OnFileDrop((_x: number, _y: number, paths: string[]) => {
      if (!paths || paths.length === 0) return;
      StatFiles(paths).then((statted: any[]) => {
        if (!statted || statted.length === 0) return;
        const newFiles: FileEntry[] = statted.map((f: any) => ({
          path: f.path,
          name: f.name,
          size: f.size,
          extension: f.extension,
          status: 'pending' as const,
        }));
        setFiles(prev => {
          const existing = new Set(prev.map(f => f.path));
          return [...prev, ...newFiles.filter(f => !existing.has(f.path))];
        });
      });
      setDragging(false);
      dragCounter.current = 0;
    }, true);
  }, []);

  // HTML drag visual feedback
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      setDragging(false);
      dragCounter.current = 0;
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    dragCounter.current = 0;
  }, []);

  const addFiles = useCallback(async () => {
    try {
      const selected = await SelectFiles();
      if (!selected || selected.length === 0) return;
      const newFiles: FileEntry[] = selected.map((f: any) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        extension: f.extension,
        status: 'pending' as const,
      }));
      setFiles(prev => {
        const existing = new Set(prev.map(f => f.path));
        return [...prev, ...newFiles.filter(f => !existing.has(f.path))];
      });
    } catch (e) {
      console.error('SelectFiles error:', e);
    }
  }, []);

  const chooseOutput = useCallback(async () => {
    try {
      const dir = await SelectFolder();
      if (dir) setOutputDir(dir);
    } catch (e) {
      console.error('SelectFolder error:', e);
    }
  }, []);

  const analyzeAll = useCallback(async () => {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setFiles(prev => prev.map((p, j) => j === i ? { ...p, status: 'analyzing' } : p));
      try {
        const result = await AnalyzePitch(f.path, detectorName);
        setFiles(prev => prev.map((p, j) => j === i ? {
          ...p,
          detectedHz: result.detectedHz,
          confidence: result.confidence,
          warning: result.warning || undefined,
          status: result.error ? 'error' : 'ready',
          error: result.error || undefined,
        } : p));
      } catch (e: any) {
        setFiles(prev => prev.map((p, j) => j === i ? { ...p, status: 'error', error: String(e) } : p));
      }
    }
  }, [files, detectorName]);

  const convertAll = useCallback(async () => {
    if (!outputDir || files.length === 0) return;
    setConverting(true);
    setSummary(null);
    setProgress({ current: 0, total: files.length, currentFile: '' });

    // Mark all as converting
    setFiles(prev => prev.map(f => ({ ...f, status: 'converting' as const })));

    // Listen for progress events
    EventsOn('conversion-progress', (data: any) => {
      setProgress({ current: data.current, total: data.total, currentFile: data.currentFile });
      setFiles(prev => prev.map((f, i) => i === data.current - 1 ? { ...f, status: 'converting' } : f));
    });

    try {
      const fileInfos = files.map(f => ({ path: f.path, name: f.name, size: f.size, extension: f.extension }));
      const results: ConvertResult[] = await ConvertBatch(fileInfos, outputDir, targetHz, threshold, detectorName, tag, eqBass, eqMid, eqTreble, outputFormat, quality, sampleRate);

      let converted = 0, skipped = 0, errors = 0;
      setFiles(prev => prev.map((f, i) => {
        const r = results[i];
        if (!r) return f;
        if (r.error) { errors++; return { ...f, status: 'error' as const, error: r.error, detectedHz: r.detectedHz, confidence: r.confidence, warning: r.warning || undefined }; }
        if (r.skipped) { skipped++; return { ...f, status: 'skipped' as const, detectedHz: r.detectedHz, confidence: r.confidence, warning: r.warning || undefined, ratio: r.ratio }; }
        converted++;
        return { ...f, status: 'done' as const, detectedHz: r.detectedHz, confidence: r.confidence, warning: r.warning || undefined, ratio: r.ratio };
      }));
      setSummary({ converted, skipped, errors });
    } catch (e: any) {
      console.error('ConvertBatch error:', e);
    } finally {
      EventsOff('conversion-progress');
      setConverting(false);
    }
  }, [files, outputDir, targetHz, threshold, detectorName, tag, eqBass, eqMid, eqTreble, outputFormat, quality, sampleRate]);

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const clearAll = () => {
    setFiles([]);
    setSummary(null);
  };

  const previewFile = async (path: string) => {
    setPreviewing(path);
    try {
      await PreviewFile(path, targetHz, detectorName, eqBass, eqMid, eqTreble);
    } catch (e: any) {
      console.error('Preview error:', e);
    } finally {
      setPreviewing(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      pending: { label: '—', cls: 'badge-dim' },
      analyzing: { label: '⟳', cls: 'badge-cyan' },
      ready: { label: 'Ready', cls: 'badge-cyan' },
      converting: { label: '⟳', cls: 'badge-yellow' },
      done: { label: '✓', cls: 'badge-green' },
      skipped: { label: 'Skip', cls: 'badge-yellow' },
      error: { label: '✗', cls: 'badge-red' },
    };
    const s = map[status] || map.pending;
    return <span className={`badge ${s.cls}`}>{s.label}</span>;
  };

  const confidenceBar = (conf?: number, warning?: string) => {
    if (conf === undefined) return <span className="dim">—</span>;
    const pctVal = Math.round(conf * 100);
    const color = pctVal >= 70 ? '#4caf50' : pctVal >= 30 ? '#ffc107' : '#f44336';
    return (
      <div className="confidence-cell" title={warning || `${pctVal}% confidence`}>
        <div className="confidence-track">
          <div className="confidence-fill" style={{ width: `${pctVal}%`, background: color }} />
        </div>
        <span className="confidence-pct" style={{ color }}>{pctVal}%</span>
        {warning && <span className="confidence-warn" title={warning}>⚠</span>}
      </div>
    );
  };

  const qualityLabel = (q: number) => {
    if (q <= 2) return 'Low';
    if (q <= 4) return 'Med';
    if (q <= 6) return 'Good';
    if (q <= 8) return 'High';
    return 'Max';
  };

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div
      className={`app ${dragging ? 'app-drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{ '--wails-drop-target': 'drop' } as React.CSSProperties}
    >
      {/* Drag overlay */}
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <span className="drop-icon">♫</span>
            <span className="drop-text">Drop audio files here</span>
          </div>
        </div>
      )}      {/* Header */}
      <header className="header">
        <h1 className="title">Decoloniz<span className="gold">-E</span></h1>
        <p className="subtitle">432Hz Resonance Engine</p>
      </header>

      {/* Controls */}
      <section className="controls">
        <div className="controls-row">
          <button className="btn btn-primary" onClick={addFiles} disabled={converting}>+ Add Files</button>
          <button className="btn" onClick={chooseOutput} disabled={converting}>
            {outputDir ? `📁 ${outputDir.split('\\').pop()}` : '📁 Output Folder'}
          </button>
          <button className="btn btn-accent" onClick={analyzeAll} disabled={converting || files.length === 0}>
            Analyze{files.length > 0 ? ` (${files.length})` : ''}
          </button>
          <button className="btn btn-green" onClick={convertAll} disabled={converting || files.length === 0 || !outputDir}>
            {converting ? `Converting ${progress.current}/${progress.total}` : `Convert${files.length > 0 ? ` (${files.length})` : ''}`}
          </button>
          <button className="btn btn-dim" onClick={clearAll} disabled={converting}>Clear</button>
        </div>
        <div className="controls-row controls-settings">
          <label>
            Target Hz
            <input type="number" value={targetHz} onChange={e => setTargetHz(Number(e.target.value))} step={0.1} min={1} className="input-sm" />
          </label>
          <label>
            Threshold
            <input type="number" value={threshold} onChange={e => setThreshold(Number(e.target.value))} step={0.1} min={0} className="input-sm" />
          </label>
          <label>
            Tag
            <input type="text" value={tag} onChange={e => setTag(e.target.value)} placeholder="(432Hz)" className="input-sm input-tag" />
          </label>
          <label>
            Detector
            <select value={detectorName} onChange={e => setDetectorName(e.target.value)} className="input-sm">
              <option value="fft">FFT</option>
              <option value="npu">NPU</option>
              <option value="mesh">Mesh</option>
            </select>
          </label>
          <div className="presets">
            {[432, 440, 528].map(hz => (
              <button key={hz} className={`btn-preset ${targetHz === hz ? 'active' : ''}`} onClick={() => setTargetHz(hz)}>{hz}</button>
            ))}
          </div>
        </div>

        {/* Output Format & Quality */}
        <div className="controls-row controls-output">
          <label>
            Format
            <select value={outputFormat} onChange={e => setOutputFormat(e.target.value)} className="input-sm input-format">
              <option value="original">Original</option>
              <option value="flac">FLAC</option>
              <option value="ogg">OGG</option>
              <option value="mp3">MP3</option>
              <option value="opus">Opus</option>
              <option value="wav">WAV</option>
              <option value="m4a">M4A</option>
            </select>
          </label>
          <label className="quality-slider">
            Quality
            <input type="range" min={1} max={10} step={1} value={quality} onChange={e => setQuality(Number(e.target.value))} />
            <span className="quality-val">{quality} <span className="dim">({qualityLabel(quality)})</span></span>
          </label>
          <label>
            Sample Rate
            <select value={sampleRate} onChange={e => setSampleRate(Number(e.target.value))} className="input-sm input-format">
              <option value={0}>Original</option>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
              <option value={96000}>96 kHz</option>
              <option value={192000}>192 kHz</option>
            </select>
          </label>
        </div>

        {/* EQ Controls */}
        <div className="controls-row controls-eq">
          <label className="eq-label">
            EQ
            <select value={eqPreset} onChange={e => applyPreset(e.target.value)} className="input-sm input-eq-select">
              {Object.keys(eqPresets).map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
              <option value="Custom">Custom</option>
            </select>
          </label>
          <label className="eq-slider">
            Bass
            <input type="range" min={-10} max={10} step={0.5} value={eqBass} onChange={e => { setEqBass(Number(e.target.value)); setEqPreset('Custom'); }} />
            <span className="eq-val">{eqBass > 0 ? '+' : ''}{eqBass}</span>
          </label>
          <label className="eq-slider">
            Mid
            <input type="range" min={-10} max={10} step={0.5} value={eqMid} onChange={e => { setEqMid(Number(e.target.value)); setEqPreset('Custom'); }} />
            <span className="eq-val">{eqMid > 0 ? '+' : ''}{eqMid}</span>
          </label>
          <label className="eq-slider">
            Treble
            <input type="range" min={-10} max={10} step={0.5} value={eqTreble} onChange={e => { setEqTreble(Number(e.target.value)); setEqPreset('Custom'); }} />
            <span className="eq-val">{eqTreble > 0 ? '+' : ''}{eqTreble}</span>
          </label>
        </div>
      </section>

      {/* Progress bar */}
      {converting && (
        <div className="progress-container">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
          <span className="progress-label">{pct}% — {progress.currentFile}</span>
        </div>
      )}

      {/* File list */}
      <section className="file-list">
        {files.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">♫</span>
            <p className="empty-title">No files added yet</p>
            <p className="dim">Click <strong>+ Add Files</strong> or drag audio files onto this window</p>
            <p className="dim empty-formats">flac · ogg · mp3 · wav · m4a · opus · wma · aac</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Detected</th>
                <th>Confidence</th>
                <th>Ratio</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => (
                <tr key={f.path} className={`file-row ${f.status === 'error' ? 'row-error' : ''} ${f.status === 'done' ? 'row-done' : ''}`}>
                  <td className="cell-name" title={f.path}>{f.name}</td>
                  <td className="cell-size">{formatSize(f.size)}</td>
                  <td className="cell-hz">{f.detectedHz ? `${f.detectedHz.toFixed(2)} Hz` : '—'}</td>
                  <td className="cell-confidence">{confidenceBar(f.confidence, f.warning)}</td>
                  <td className="cell-ratio">{f.ratio ? f.ratio.toFixed(6) : '—'}</td>
                  <td>{statusBadge(f.status)}</td>
                  <td>
                    {!converting && (
                      <span className="row-actions">
                        <button className="btn-preview" onClick={() => previewFile(f.path)} disabled={previewing === f.path} title="Preview 30s clip">
                          {previewing === f.path ? '⟳' : '▶'}
                        </button>
                        <button className="btn-remove" onClick={() => removeFile(i)} title="Remove">×</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Summary */}
      {summary && (
        <footer className="summary">
          <span className="green">✓ {summary.converted} converted</span>
          <span className="sep">·</span>
          <span className="yellow">→ {summary.skipped} skipped</span>
          <span className="sep">·</span>
          <span className="red">✗ {summary.errors} errors</span>
          <span className="sep">·</span>
          <span className="dim">{files.length} total</span>
        </footer>
      )}

      {/* Footer */}
      <footer className="status-bar">
        <span className="dim">{files.length} file{files.length !== 1 ? 's' : ''}</span>
        <span className="dim">Detector: {detectorName.toUpperCase()}</span>
        <span className="dim">
          {outputFormat === 'original' ? 'Original format' : outputFormat.toUpperCase()} · Q{quality}
        </span>
        <span className="dim">Target: {targetHz} Hz</span>
      </footer>
    </div>
  );
}

export default App;
