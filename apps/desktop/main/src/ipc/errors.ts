import {
  AiExecutionError,
  DocumentImportError,
  DocumentProcessingError,
  EntityResolutionError,
  PrivacyDetectionError,
  ReviewOperationError,
  ReviewQueryError,
  SanitizationError,
  WorkspaceLifecycleError
} from '@aliasai/application'
import { OpenAiCompatibleProviderError } from '@aliasai/ai'
import { PythonRuntimeError } from '../runtime'
import { AiProviderConfigError } from '../ai-provider'
import { KeyStoreError } from '../keys'
import { IpcValidationError } from './validate'

export type IpcResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

interface CodedError {
  readonly code: string
  readonly message: string
}

function isCodedError(error: unknown): error is CodedError {
  return (
    error instanceof AiExecutionError ||
    error instanceof DocumentProcessingError ||
    error instanceof PrivacyDetectionError ||
    error instanceof EntityResolutionError ||
    error instanceof SanitizationError ||
    error instanceof ReviewQueryError ||
    error instanceof ReviewOperationError ||
    error instanceof WorkspaceLifecycleError ||
    error instanceof DocumentImportError ||
    error instanceof KeyStoreError ||
    error instanceof PythonRuntimeError ||
    error instanceof AiProviderConfigError ||
    error instanceof OpenAiCompatibleProviderError ||
    error instanceof IpcValidationError
  )
}

/**
 * The single error choke point: known service errors surface their code and
 * their own (static, path-free) message; everything else collapses to a
 * generic INTERNAL_ERROR. Causes and stacks never cross the boundary, so file
 * paths or decrypted values inside a raw Error cannot leak to the renderer.
 */
export async function toIpcResult<T>(operation: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await operation() }
  } catch (error) {
    if (isCodedError(error)) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' } }
  }
}
