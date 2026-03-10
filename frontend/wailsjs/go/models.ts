export namespace main {
	
	export class ConvertResult {
	    inputPath: string;
	    outputPath: string;
	    detectedHz: number;
	    confidence: number;
	    targetHz: number;
	    ratio: number;
	    skipped: boolean;
	    warning?: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConvertResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inputPath = source["inputPath"];
	        this.outputPath = source["outputPath"];
	        this.detectedHz = source["detectedHz"];
	        this.confidence = source["confidence"];
	        this.targetHz = source["targetHz"];
	        this.ratio = source["ratio"];
	        this.skipped = source["skipped"];
	        this.warning = source["warning"];
	        this.error = source["error"];
	    }
	}
	export class EQPreset {
	    name: string;
	    bass: number;
	    mid: number;
	    treble: number;
	
	    static createFrom(source: any = {}) {
	        return new EQPreset(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.bass = source["bass"];
	        this.mid = source["mid"];
	        this.treble = source["treble"];
	    }
	}
	export class FileInfo {
	    path: string;
	    name: string;
	    size: number;
	    extension: string;
	
	    static createFrom(source: any = {}) {
	        return new FileInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.size = source["size"];
	        this.extension = source["extension"];
	    }
	}
	export class PitchResult {
	    path: string;
	    detectedHz: number;
	    confidence: number;
	    sampleRate: number;
	    warning?: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new PitchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.detectedHz = source["detectedHz"];
	        this.confidence = source["confidence"];
	        this.sampleRate = source["sampleRate"];
	        this.warning = source["warning"];
	        this.error = source["error"];
	    }
	}

}

