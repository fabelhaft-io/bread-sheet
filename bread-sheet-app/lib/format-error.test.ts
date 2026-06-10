import { ApiError } from './api';
import { formatApiError } from './format-error';

jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

describe('formatApiError', () => {
  it('returns auth-specific copy for 401', () => {
    const err = new ApiError(401, 'jwt expired', {});
    expect(formatApiError(err)).toMatch(/session has expired/i);
  });

  it('forwards the server message for 403 when it is meaningful', () => {
    const err = new ApiError(403, 'Registration required', { error: 'Registration required' });
    expect(formatApiError(err)).toBe('Registration required');
  });

  it('substitutes generic copy for an empty 403 message', () => {
    const err = new ApiError(403, '', {});
    expect(formatApiError(err)).toMatch(/permission/i);
  });

  it('returns short 404 copy regardless of server message', () => {
    const err = new ApiError(404, 'Resource missing in DB', {});
    expect(formatApiError(err)).toMatch(/could not find/i);
  });

  it('returns rate-limit copy for 429', () => {
    const err = new ApiError(429, 'too many requests', {});
    expect(formatApiError(err)).toMatch(/too often|try again/i);
  });

  it('NEVER forwards a 5xx server message — uses the fallback or default copy', () => {
    const err = new ApiError(
      500,
      'PrismaClientKnownRequestError: FK constraint Rating_userId_fkey on column userId',
      {},
    );
    const msg = formatApiError(err, 'Could not submit your rating. Please try again.');
    expect(msg).toBe('Could not submit your rating. Please try again.');
    expect(msg).not.toMatch(/prisma|userId|FK/i);
  });

  it('uses the default fallback for 5xx when no custom fallback is supplied', () => {
    const err = new ApiError(503, 'database unreachable', {});
    expect(formatApiError(err)).toMatch(/something went wrong/i);
  });

  it('forwards the server message for unmapped 4xx (e.g. 400 validation)', () => {
    const err = new ApiError(400, 'taste must be between 0 and 10 in 0.5 increments', {});
    expect(formatApiError(err)).toBe('taste must be between 0 and 10 in 0.5 increments');
  });

  it('returns the fallback for arbitrary network errors', () => {
    const err = new Error('Network request failed');
    expect(formatApiError(err)).toMatch(/something went wrong/i);
    expect(formatApiError(err, 'Could not load product')).toBe('Could not load product');
  });

  it('returns the fallback for non-Error throwables', () => {
    expect(formatApiError('weird thing thrown')).toMatch(/something went wrong/i);
  });
});
