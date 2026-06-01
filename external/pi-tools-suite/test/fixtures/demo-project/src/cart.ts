export interface CartItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CartTotals {
  subtotalCents: number;
  itemCount: number;
}

export function calculateCartTotals(items: CartItem[]): CartTotals {
  return items.reduce<CartTotals>(
    (totals, item) => ({
      subtotalCents: totals.subtotalCents + item.quantity * item.unitPriceCents,
      itemCount: totals.itemCount + item.quantity,
    }),
    { subtotalCents: 0, itemCount: 0 },
  );
}
