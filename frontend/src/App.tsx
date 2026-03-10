import { useState, useCallback } from 'react';
import './App.css';
import {
  SelectFiles,
  SelectFolder,
  AnalyzePitch,
  ConvertBatch,
  GetDetectors,
  GetSupportedFormats,
} from '../wailsjs/go/main/App';
import { EventsOn, EventsOff } from '../wailsjs/runtime/runtime';

interface FileEntry {
  path: string;
  name: string;
  size: number;
  extension: string;
  detectedHz?: number;
  status: 'pending' | 'analyzing' | 'ready' | 'converting' | 'done' | 'skipped' | 'error';
  error?: string;
  ratio?: number;
}

interface ConvertResult {
  inputPath: string;
  outputPath: string;
  detectedHz: number;
  targetHz: number;
  ratio: number;
  skipped: boolean;
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
      const results: ConvertResult[] = await ConvertBatch(fileInfos, outputDir, targetHz, threshold, detectorName, tag);

      let converted = 0, skipped = 0, errors = 0;
      setFiles(prev => prev.map((f, i) => {
        const r = results[i];
        if (!r) return f;
        if (r.error) { errors++; return { ...f, status: 'error' as const, error: r.error, detectedHz: r.detectedHz }; }
        if (r.skipped) { skipped++; return { ...f, status: 'skipped' as const, detectedHz: r.detectedHz, ratio: r.ratio }; }
        converted++;
        return { ...f, status: 'done' as const, detectedHz: r.detectedHz, ratio: r.ratio };
      }));
      setSummary({ converted, skipped, errors });
    } catch (e: any) {
      console.error('ConvertBatch error:', e);
    } finally {
      EventsOff('conversion-progress');
      setConverting(false);
    }
  }, [files, outputDir, targetHz, threshold, detectorName, tag]);

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const clearAll = () => {
    setFiles([]);
    setSummary(null);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      pending: { label: '—', cls: 'badge-dim' },
      analyzing: { label: '...', cls: 'badge-cyan' },
      ready: { label: 'Ready', cls: 'badge-cyan' },
      converting: { label: 'Converting', cls: 'badge-yellow' },
      done: { label: 'OK', cls: 'badge-green' },
      skipped: { label: 'Skip', cls: 'badge-yellow' },
      error: { label: 'Error', cls: 'badge-red' },
    };
    const s = map[status] || map.pending;
    return <span className={`badge ${s.cls}`}>{s.label}</span>;
  };

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <h1 className="title">Decoloniz<span className="gold">-E</span></h1>
        <p className="subtitle">432Hz Resonance Engine</p>
      </header>

      {/* Controls */}
      <section className="controls">
        <div className="controls-row">
          <button className="btn btn-primary" onClick={addFiles} disabled={converting}>Add Files</button>
          <button className="btn" onClick={chooseOutput} disabled={converting}>
            {outputDir ? `Output: ${outputDir.split('\\').pop()}` : 'Output Folder'}
          </button>
          <button className="btn btn-accent" onClick={analyzeAll} disabled={converting || files.length === 0}>Analyze</button>
          <button className="btn btn-green" onClick={convertAll} disabled={converting || files.length === 0 || !outputDir}>
            {converting ? `Converting ${progress.current}/${progress.total}` : 'Convert'}
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
            <p>No files added yet</p>
            <p className="dim">Click "Add Files" or drag audio files onto this window</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Detected</th>
                <th>Ratio</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => (
                <tr key={f.path} className={f.status === 'error' ? 'row-error' : ''}>
                  <td className="cell-name" title={f.path}>{f.name}</td>
                  <td className="cell-size">{formatSize(f.size)}</td>
                  <td className="cell-hz">{f.detectedHz ? `${f.detectedHz.toFixed(2)} Hz` : '—'}</td>
                  <td className="cell-ratio">{f.ratio ? f.ratio.toFixed(6) : '—'}</td>
                  <td>{statusBadge(f.status)}</td>
                  <td>
                    {!converting && (
                      <button className="btn-remove" onClick={() => removeFile(i)} title="Remove">×</button>
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
          <span className="green">{summary.converted} converted</span>
          <span className="sep">·</span>
          <span className="yellow">{summary.skipped} skipped</span>
          <span className="sep">·</span>
          <span className="red">{summary.errors} errors</span>
          <span className="sep">·</span>
          <span className="dim">{files.length} total</span>
        </footer>
      )}

      {/* Footer */}
      <footer className="status-bar">
        <span className="dim">{files.length} file{files.length !== 1 ? 's' : ''}</span>
        <span className="dim">Detector: {detectorName.toUpperCase()}</span>
        <span className="dim">Target: {targetHz} Hz</span>
      </footer>
    </div>
  );
}

export default App;
