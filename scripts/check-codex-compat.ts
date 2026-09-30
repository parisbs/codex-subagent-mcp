/** One argv the server can build, named for the report. */
export interface Shape {
  name: string;
  argv: string[];
}

/** What running the CLI once produced. */
export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Report {
  version: string;
  failures: string[];
  notes: string[];
}

export const NEGATIVE_CONTROL: string[] = ["exec", "--full-auto"];

export function argvShapes(_model: string, _dir: string): Shape[] {
  throw new Error("not implemented");
}

export function checkCompatibility(_input: {
  version: string;
  newestVerified: string;
  dir: string;
  run: (args: string[]) => CliRun;
}): Report {
  throw new Error("not implemented");
}

export function shimProblem(_path: string): string | null {
  throw new Error("not implemented");
}

export function findCodexBinary(_prefix: string, _platform: NodeJS.Platform = process.platform): string | null {
  throw new Error("not implemented");
}
