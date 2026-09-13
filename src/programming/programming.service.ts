import { Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { CentralManagerService } from '../central/central-manager.service';

const CV_READ_MAX_RETRIES = 3;
const CV_READ_RETRY_DELAY_MS = 200;
const CV_WRITE_INTER_DELAY_MS = 300;

export interface CvReadResult  { cv: number; value: number; }
export interface CvWriteResult { cv: number; value: number; }
export interface CvError       { cv: number; error: string; }

export interface ReadManyCvsResult {
  cvValues: Record<number, number>;
  errors: CvError[];
  total: number;
  read: number;
  failed: number;
}

export interface WriteManyItem  { cv: number; value: number; }
export interface WriteManyResult {
  results: Array<{ cv: number; value: number; success: boolean; error?: string }>;
  total: number;
  success: number;
  failed: number;
}

// z21-client engine calls resolve with a { cv, value } CvResultData on success
// and *reject* with { code, message } on NACK / protocol errors — never resolve
// with an error shape. So the try bodies below only ever see the success value;
// all error handling lives in the catch (getNackCode / extractMessage).

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === 'object' && 'message' in err) {
    return String(err.message);
  }
  return String(err);
}

// z21-client rejects with { code: 'nack' | 'nack-sc' | 'invalid-payload', message: string }
// NACK = decoder did not acknowledge (CV may not exist or decoder not ready)
// NACK-SC = short circuit detected on the programming track
function getNackCode(err: unknown): 'nack' | 'nack-sc' | null {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'nack' || code === 'nack-sc') return code;
  }
  return null;
}

// Throw an appropriate NestJS HTTP exception for NACK errors.
// Returns void (never throws non-NestJS) so callers can use: throwIfNack(err, ctx) ?? throw err
function throwIfNack(err: unknown, context: string): void {
  const code = getNackCode(err);
  if (code === 'nack-sc') {
    throw new ServiceUnavailableException(`${context}: short circuit on programming track`);
  }
  if (code === 'nack') {
    throw new UnprocessableEntityException(`${context}: decoder did not acknowledge (NACK)`);
  }
}

@Injectable()
export class ProgrammingService {
  private readonly logger = new Logger(ProgrammingService.name);

  constructor(private readonly centralManager: CentralManagerService) {}

  private getEngines(centralId: string) {
    const client = this.centralManager.getClient(centralId);
    if (!client) throw new NotFoundException(`Central "${centralId}" not found`);
    if (client.status !== 'connected') {
      this.logger.warn(`CV op rejected: central "${centralId}" status="${client.status}"`);
      throw new ServiceUnavailableException(`Central "${centralId}" is not connected`);
    }
    return client.engines;
  }

  private async readWithRetry(centralId: string, cv: number): Promise<number> {
    const engines = this.getEngines(centralId);
    let lastError: unknown;
    for (let attempt = 1; attempt <= CV_READ_MAX_RETRIES; attempt++) {
      try {
        const result = await engines.cvRead(cv);
        return result.value;
      } catch (err) {
        lastError = err;
        const msg = extractMessage(err);
        this.logger.warn(`CV${cv} read attempt ${attempt}/${CV_READ_MAX_RETRIES} failed: ${msg}`);
        // NACK is a definitive decoder response — retrying won't help
        if (getNackCode(err)) break;
        if (attempt < CV_READ_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, CV_READ_RETRY_DELAY_MS));
        }
      }
    }
    throwIfNack(lastError, `CV${cv}`);
    throw lastError;
  }

  async cvRead(centralId: string, cv: number): Promise<CvReadResult> {
    const value = await this.readWithRetry(centralId, cv);
    return { cv, value };
  }

  async cvWrite(centralId: string, cv: number, value: number): Promise<CvWriteResult> {
    const engines = this.getEngines(centralId);
    try {
      const result = await engines.cvWrite(cv, value);
      return { cv, value: result.value };
    } catch (err) {
      throwIfNack(err, `CV${cv}`);
      throw err;
    }
  }

  async cvReadMany(centralId: string, cvs: number[]): Promise<ReadManyCvsResult> {
    const cvValues: Record<number, number> = {};
    const errors: CvError[] = [];
    for (const cv of cvs) {
      try {
        cvValues[cv] = await this.readWithRetry(centralId, cv);
      } catch (err) {
        errors.push({ cv, error: extractMessage(err) });
      }
    }
    return { cvValues, errors, total: cvs.length, read: Object.keys(cvValues).length, failed: errors.length };
  }

  async cvReadIndexed(centralId: string, indexHigh: number, indexLow: number, cv: number): Promise<CvReadResult> {
    const engines = this.getEngines(centralId);
    try {
      const result = await engines.cvReadIndexed(indexHigh, indexLow, cv);
      return { cv, value: result.value };
    } catch (err) {
      throwIfNack(err, `CV${cv} (indexed)`);
      throw err;
    }
  }

  async cvWriteMany(centralId: string, items: WriteManyItem[]): Promise<WriteManyResult> {
    const engines = this.getEngines(centralId);
    const results: WriteManyResult['results'] = [];
    for (const [i, { cv, value }] of items.entries()) {
      if (i > 0) await new Promise<void>(r => setTimeout(r, CV_WRITE_INTER_DELAY_MS));
      try {
        await engines.cvWrite(cv, value);
        results.push({ cv, value, success: true });
      } catch (err) {
        results.push({ cv, value, success: false, error: extractMessage(err) });
      }
    }
    return {
      results,
      total: items.length,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    };
  }

}
