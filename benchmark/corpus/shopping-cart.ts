// Types for the in-memory cart demo.
export const TAX_RATE = 0.2;
const MAX_ITEMS = 500;

// An in-memory shopping cart for the demo API.
// It mirrors a real service: guards, rounding, totals, receipts.
// The benchmark edit script in benchmark/run.mjs is anchored to this file's
// exact line layout — do not reformat it without updating the edit script.
type CartItem = { sku: string; qty: number; unitPrice: number };
type CheckoutReceipt = {
  lines: Array<{ sku: string; qty: number; lineTotal: number }>;
  subtotal: number;
  tax: number;
  total: number;
};

export class Cart {
  private items = new Map<string, CartItem>();

  constructor(seed?: Iterable<[string, CartItem]>) {
    if (seed) {
      this.items = new Map(seed);
    } else {
      this.items = new Map();
    }
  }

  get size(): number {
    return this.items.size;
  }

  addItem(sku: string, qty: number, unitPrice: number): void {
    if (this.items.size >= MAX_ITEMS) {
      throw new CartError("cart is full");
    }
    if (qty <= 0) {
      throw new CartError("quantity must be positive");
    }
    if (unitPrice < 0) {
      throw new CartError("price must not be negative");
    }
    const existing = this.items.get(sku);
    if (existing) {
      existing.qty += qty;
      existing.unitPrice = unitPrice;
    } else {
      this.items.set(sku, { sku, qty, unitPrice });
    }
  }

  removeItem(sku: string): void {
    this.items.delete(sku);
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  get subtotal(): number {
    let total = 0;
    for (const item of this.items.values()) {
      total += item.unitPrice * item.qty;
    }
    return this.round2(total);
  }

  get tax(): number {
    return this.round2(this.subtotal * TAX_RATE);
  }

  get total(): number {
    const subtotal = this.subtotal;
    return this.round2(subtotal + this.tax);
  }

  checkout(): CheckoutReceipt {
    const lines = [...this.items.values()].map((item) => ({
      sku: item.sku,
      qty: item.qty,
      lineTotal: this.round2(item.unitPrice * item.qty),
    }));
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const tax = this.round2(subtotal * TAX_RATE);
    const total = this.round2(subtotal + tax);
    this.items.clear();
    return { lines, subtotal, tax, total };
  }
}

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartError";
  }
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars}.${String(rem).padStart(2, "0")}`;
}
