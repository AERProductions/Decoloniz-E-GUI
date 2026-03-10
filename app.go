package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"decoloniz-e-gui/audio"
	"decoloniz-e-gui/detector"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the primary backend bound to the Wails frontend.
type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// --- Types exposed to JS ---

type FileInfo struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Extension string `json:"extension"`
}

type PitchResult struct {
	Path       string  `json:"path"`
	DetectedHz float64 `json:"detectedHz"`
	Confidence float64 `json:"confidence"`
	SampleRate int     `json:"sampleRate"`
	Warning    string  `json:"warning,omitempty"`
	Error      string  `json:"error,omitempty"`
}

type ConvertResult struct {
	InputPath  string  `json:"inputPath"`
	OutputPath string  `json:"outputPath"`
	DetectedHz float64 `json:"detectedHz"`
	Confidence float64 `json:"confidence"`
	TargetHz   float64 `json:"targetHz"`
	Ratio      float64 `json:"ratio"`
	Skipped    bool    `json:"skipped"`
	Warning    string  `json:"warning,omitempty"`
	Error      string  `json:"error,omitempty"`
}

type BatchProgress struct {
	Current     int    `json:"current"`
	Total       int    `json:"total"`
	CurrentFile string `json:"currentFile"`
}

type EQPreset struct {
	Name   string  `json:"name"`
	Bass   float64 `json:"bass"`
	Mid    float64 `json:"mid"`
	Treble float64 `json:"treble"`
}

// StatFiles takes a list of file paths (e.g. from drag-and-drop) and returns
// FileInfo for each valid audio file.
func (a *App) StatFiles(paths []string) []FileInfo {
	var files []FileInfo
	for _, p := range paths {
		if !audio.IsSupportedFile(p) {
			continue
		}
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Path:      p,
			Name:      filepath.Base(p),
			Size:      info.Size(),
			Extension: strings.ToLower(filepath.Ext(p)),
		})
	}
	return files
}

// --- File dialogs ---

func (a *App) SelectFiles() ([]FileInfo, error) {
	selection, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Audio Files",
		Filters: []runtime.FileFilter{
			{DisplayName: "Audio Files", Pattern: "*.flac;*.ogg;*.mp3;*.wav;*.m4a;*.opus;*.wma;*.aac"},
			{DisplayName: "All Files", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}

	var files []FileInfo
	for _, p := range selection {
		if info, err := os.Stat(p); err == nil {
			files = append(files, FileInfo{
				Path:      p,
				Name:      filepath.Base(p),
				Size:      info.Size(),
				Extension: strings.ToLower(filepath.Ext(p)),
			})
		}
	}
	return files, nil
}

func (a *App) SelectFolder() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Output Folder",
	})
}

// --- Metadata ---

func (a *App) GetDetectors() []string {
	return []string{"fft", "npu", "mesh"}
}

func (a *App) GetSupportedFormats() []string {
	var exts []string
	for ext := range audio.SupportedExtensions {
		exts = append(exts, ext)
	}
	return exts
}

func (a *App) GetEQPresets() []EQPreset {
	return []EQPreset{
		{Name: "Flat", Bass: 0, Mid: 0, Treble: 0},
		{Name: "Warm", Bass: 3, Mid: 0, Treble: -2},
		{Name: "Deep", Bass: 6, Mid: -2, Treble: -1},
		{Name: "Bright", Bass: -1, Mid: 0, Treble: 4},
	}
}

// PreviewFile generates a 30-second preview clip with formant-preserving pitch shift
// and optional EQ, then opens it in the OS default audio player.
func (a *App) PreviewFile(filePath string, targetHz float64, detectorName string, bass, mid, treble float64) (string, error) {
	det := pickDetector(detectorName)

	samples, sampleRate, err := audio.DecodeToPCM(filePath)
	if err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}

	chunkSize := 65536
	if len(samples) < chunkSize {
		chunkSize = len(samples)
	}
	offset := (len(samples) - chunkSize) / 2
	chunk := samples[offset : offset+chunkSize]

	detected, _, err := det.Detect(chunk, sampleRate)
	if err != nil {
		return "", fmt.Errorf("detect: %w", err)
	}

	ratio := targetHz / detected
	var eq *audio.EQSettings
	if bass != 0 || mid != 0 || treble != 0 {
		eq = &audio.EQSettings{Bass: bass, Mid: mid, Treble: treble}
	}

	tmpDir := os.TempDir()
	ext := filepath.Ext(filePath)
	previewPath := filepath.Join(tmpDir, "decolonize_preview"+ext)

	// Start the preview 30 seconds into the song (or 0 if short)
	startSec := 30.0
	if err := audio.GeneratePreview(filePath, previewPath, ratio, eq, startSec, 30.0); err != nil {
		return "", fmt.Errorf("preview: %w", err)
	}

	// Open in OS default player
	exec.Command("cmd", "/c", "start", "", previewPath).Start()

	return previewPath, nil
}

// --- Analysis ---

func (a *App) AnalyzePitch(filePath string, detectorName string) PitchResult {
	det := pickDetector(detectorName)

	samples, sampleRate, err := audio.DecodeToPCM(filePath)
	if err != nil {
		return PitchResult{Path: filePath, Error: fmt.Sprintf("decode: %v", err)}
	}

	chunkSize := 65536
	if len(samples) < chunkSize {
		chunkSize = len(samples)
	}
	offset := (len(samples) - chunkSize) / 2
	chunk := samples[offset : offset+chunkSize]

	detected, confidence, err := det.Detect(chunk, sampleRate)
	if err != nil {
		return PitchResult{Path: filePath, SampleRate: sampleRate, Error: fmt.Sprintf("detect: %v", err)}
	}

	var warning string
	if confidence < 0.3 {
		warning = fmt.Sprintf("Low confidence (%.0f%%) — detection may be unreliable", confidence*100)
	}

	return PitchResult{Path: filePath, DetectedHz: detected, Confidence: confidence, SampleRate: sampleRate, Warning: warning}
}

// --- Conversion ---

func (a *App) ConvertFile(inPath, outPath string, targetHz float64, threshold float64, detectorName string, tag string, bass, mid, treble float64, outputFormat string, quality int, sampleRate int) ConvertResult {
	det := pickDetector(detectorName)

	samples, sampleRate, err := audio.DecodeToPCM(inPath)
	if err != nil {
		return ConvertResult{InputPath: inPath, Error: fmt.Sprintf("decode: %v", err)}
	}

	chunkSize := 65536
	if len(samples) < chunkSize {
		chunkSize = len(samples)
	}
	offset := (len(samples) - chunkSize) / 2
	chunk := samples[offset : offset+chunkSize]

	detected, confidence, err := det.Detect(chunk, sampleRate)
	if err != nil {
		return ConvertResult{InputPath: inPath, Error: fmt.Sprintf("detect: %v", err)}
	}

	var warning string
	shiftPct := math.Abs(detected-targetHz) / detected * 100
	if confidence < 0.3 {
		warning = fmt.Sprintf("Low confidence (%.0f%%)", confidence*100)
	} else if shiftPct > 5 {
		warning = fmt.Sprintf("Large shift %.1f%% — may not be standard tuning", shiftPct)
	}

	if math.Abs(detected-targetHz) <= threshold {
		return ConvertResult{InputPath: inPath, OutputPath: outPath, DetectedHz: detected, Confidence: confidence, TargetHz: targetHz, Ratio: 1.0, Skipped: true, Warning: warning}
	}

	ratio := targetHz / detected

	// Handle output format conversion — change extension if format specified
	if outputFormat != "" && outputFormat != "original" {
		ext := "." + outputFormat
		base := strings.TrimSuffix(filepath.Base(outPath), filepath.Ext(outPath))
		outPath = filepath.Join(filepath.Dir(outPath), base+ext)
	}

	outDir := filepath.Dir(outPath)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return ConvertResult{InputPath: inPath, Error: fmt.Sprintf("mkdir: %v", err)}
	}

	var eq *audio.EQSettings
	if bass != 0 || mid != 0 || treble != 0 {
		eq = &audio.EQSettings{Bass: bass, Mid: mid, Treble: treble}
	}

	if err := audio.ConvertFormant(inPath, outPath, ratio, eq, tag, quality, sampleRate); err != nil {
		return ConvertResult{InputPath: inPath, Error: fmt.Sprintf("convert: %v", err)}
	}

	return ConvertResult{InputPath: inPath, OutputPath: outPath, DetectedHz: detected, Confidence: confidence, TargetHz: targetHz, Ratio: ratio, Warning: warning}
}

func (a *App) ConvertBatch(files []FileInfo, outputDir string, targetHz float64, threshold float64, detectorName string, tag string, bass, mid, treble float64, outputFormat string, quality int, sampleRate int) []ConvertResult {
	var results []ConvertResult
	total := len(files)

	for i, f := range files {
		runtime.EventsEmit(a.ctx, "conversion-progress", BatchProgress{
			Current:     i + 1,
			Total:       total,
			CurrentFile: f.Name,
		})

		outPath := filepath.Join(outputDir, f.Name)
		r := a.ConvertFile(f.Path, outPath, targetHz, threshold, detectorName, tag, bass, mid, treble, outputFormat, quality, sampleRate)
		results = append(results, r)
	}

	return results
}

// --- Helpers ---

func pickDetector(name string) detector.Detector {
	switch name {
	case "npu":
		return &detector.NPUDetector{}
	case "fft":
		return &detector.FFTDetector{}
	default:
		return &detector.FFTDetector{}
	}
}
