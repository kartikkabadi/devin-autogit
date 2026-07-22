/**
 * Output discipline: everything informational goes to stderr; machine-readable
 * results (--json) go to stdout. Exit codes: 0 = shipped/held/no-op,
 * 1 = configuration or user error, 2 reserved (never used).
 */

export interface JsonResult {
  ok: boolean;
  action: string;
  [key: string]: unknown;
}

export interface OutputOptions {
  json: boolean;
  stderr?: (line: string) => void;
  stdout?: (line: string) => void;
}

export class Output {
  readonly json: boolean;
  private readonly writeErr: (line: string) => void;
  private readonly writeOut: (line: string) => void;

  constructor(opts: OutputOptions) {
    this.json = opts.json;
    this.writeErr = opts.stderr ?? ((line) => process.stderr.write(line + '\n'));
    this.writeOut = opts.stdout ?? ((line) => process.stdout.write(line + '\n'));
  }

  info(message: string): void {
    this.writeErr(`devin-autogit: ${message}`);
  }

  warn(message: string): void {
    this.writeErr(`devin-autogit: warning: ${message}`);
  }

  error(message: string): void {
    this.writeErr(`devin-autogit: error: ${message}`);
  }

  /** Emit the machine-readable result on stdout when --json is set. */
  result(result: JsonResult): void {
    if (this.json) {
      this.writeOut(JSON.stringify(result));
    }
  }
}

/** Exit code for shipped, held, or clean no-op outcomes. Never breaks an agent turn. */
export const EXIT_OK = 0;
/** Exit code for configuration or user errors. */
export const EXIT_CONFIG_ERROR = 1;
