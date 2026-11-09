export type RetailPlan = 'aisles' | 'cross-aisle' | 'islands';
export const RETAIL_PLANS: RetailPlan[] = ['aisles', 'cross-aisle', 'islands'];

/** Break a merchandising run into bays without moving its outer footprint or queue space. */
export function retailBays(start: number, end: number, plan: RetailPlan) {
  const length = end - start;
  const gap = 1.2;
  const desired = plan === 'aisles' ? 1 : plan === 'cross-aisle' ? 2 : 3;
  const count = Math.max(1, Math.min(desired, Math.floor((length + gap) / (1.2 + gap))));
  const size = (length - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({ center: start + size / 2 + i * (size + gap), length: size }));
}
