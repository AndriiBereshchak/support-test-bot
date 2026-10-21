export async function grpcDeleteUser(_uid: string): Promise<never> {
  throw new Error(
    'Exchange account deletion is unavailable in the standalone development server'
  )
}
