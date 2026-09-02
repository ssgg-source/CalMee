import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { mutationResources } from './refresh-state';
import { publishDataChanges } from './data-events';
export * from '@tauri-apps/api/core';

/** The one mutation boundary. Failed/partially committed batches also reconcile. */
export async function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const resources = mutationResources(command, args && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array) ? args : {});
  let succeeded = false;
  try { const result = await nativeInvoke<T>(command, args, options); succeeded = true; return result; }
  finally { publishDataChanges(succeeded ? resources : resources.filter(key => !key.startsWith('deleted:'))); }
}
