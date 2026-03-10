package main

import (
	"context"
	"fmt"
	"math"
	"os"
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

func (a *App) ConvertFile(inPath, outPath string, targetHz float64, threshold float64, detectorName string, tag string) ConvertResult {
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

	outDir := filepath.Dir(outPath)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return ConvertResult{InputPath: inPath, Error: fmt.Sprintf("mkdir: %v", err)}
	}

	if err := audio.ConvertWithSampleRate(inPath, outPath, ratio, sampleRate, tag); err != nil {
		return ConvertResult{InputPath: inPath, Error: fmt.Sprintf("convert: %v", err)}
	}

	return ConvertResult{InputPath: inPath, OutputPath: outPath, DetectedHz: detected, Confidence: confidence, TargetHz: targetHz, Ratio: ratio, Warning: warning}
}

func (a *App) ConvertBatch(files []FileInfo, outputDir string, targetHz float64, threshold float64, detectorName string, tag string) []ConvertResult {
	var results []ConvertResult
	total := len(files)

	for i, f := range files {
		runtime.EventsEmit(a.ctx, "conversion-progress", BatchProgress{
			Current:     i + 1,
			Total:       total,
			CurrentFile: f.Name,
		})

		outPath := filepath.Join(outputDir, f.Name)
		r := a.ConvertFile(f.Path, outPath, targetHz, threshold, detectorName, tag)
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
