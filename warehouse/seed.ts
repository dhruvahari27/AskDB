/**
 * Synthetic Olist-shaped dataset, generated deterministically from a seed.
 *
 * Why synthetic: the real Olist files are behind a Kaggle login, so they cannot ship in this repo.
 * The generator reproduces the traits that make the real data hard for text-to-SQL:
 *   - customer_id is unique PER ORDER; customer_unique_id identifies the person
 *   - payment_value includes freight, items.price does not
 *   - orders can be canceled; one order can have several payments and several items
 *   - dates span Jan 2017 .. Aug 2018 (so "last month" only makes sense relative to the data, not today)
 * Drop the real CSVs into warehouse/data/ and `npm run setup -- --reset-warehouse` loads those instead.
 */

export type Row = (string | number | null)[];

export interface Dataset {
  customers: Row[];
  sellers: Row[];
  product_category_name_translation: Row[];
  products: Row[];
  orders: Row[];
  order_items: Row[];
  order_payments: Row[];
  order_reviews: Row[];
}

export const TABLE_COLUMNS: Record<keyof Dataset, string[]> = {
  customers: ['customer_id', 'customer_unique_id', 'customer_zip_code_prefix', 'customer_city', 'customer_state'],
  sellers: ['seller_id', 'seller_zip_code_prefix', 'seller_city', 'seller_state'],
  product_category_name_translation: ['product_category_name', 'product_category_name_english'],
  products: [
    'product_id', 'product_category_name', 'product_name_length', 'product_description_length',
    'product_photos_qty', 'product_weight_g', 'product_length_cm', 'product_height_cm', 'product_width_cm',
  ],
  orders: [
    'order_id', 'customer_id', 'order_status', 'order_purchase_timestamp', 'order_approved_at',
    'order_delivered_carrier_date', 'order_delivered_customer_date', 'order_estimated_delivery_date',
  ],
  order_items: ['order_id', 'order_item_id', 'product_id', 'seller_id', 'shipping_limit_date', 'price', 'freight_value'],
  order_payments: ['order_id', 'payment_sequential', 'payment_type', 'payment_installments', 'payment_value'],
  order_reviews: [
    'review_id', 'order_id', 'review_score', 'review_comment_title', 'review_comment_message',
    'review_creation_date', 'review_answer_timestamp',
  ],
};

/** Load order matters because of foreign keys. */
export const LOAD_ORDER: (keyof Dataset)[] = [
  'customers', 'sellers', 'product_category_name_translation', 'products',
  'orders', 'order_items', 'order_payments', 'order_reviews',
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES: [string, string, number][] = [
  ['cama_mesa_banho', 'bed_bath_table', 11],
  ['beleza_saude', 'health_beauty', 10],
  ['esporte_lazer', 'sports_leisure', 9],
  ['informatica_acessorios', 'computers_accessories', 8],
  ['moveis_decoracao', 'furniture_decor', 8],
  ['utilidades_domesticas', 'housewares', 7],
  ['relogios_presentes', 'watches_gifts', 6],
  ['telefonia', 'telephony', 5],
  ['automotivo', 'auto', 4],
  ['brinquedos', 'toys', 4],
  ['cool_stuff', 'cool_stuff', 3],
  ['perfumaria', 'perfumery', 3],
  ['bebes', 'baby', 3],
  ['eletronicos', 'electronics', 3],
  ['papelaria', 'stationery', 2],
  ['fashion_bolsas_e_acessorios', 'fashion_bags_accessories', 2],
  ['pet_shop', 'pet_shop', 2],
  ['ferramentas_jardim', 'garden_tools', 3],
  ['livros_interesse_geral', 'books_general_interest', 1],
  ['alimentos', 'food', 1],
];

const STATES: [string, number, string[]][] = [
  ['SP', 42, ['sao paulo', 'campinas', 'santos', 'guarulhos', 'sao bernardo do campo', 'ribeirao preto']],
  ['RJ', 13, ['rio de janeiro', 'niteroi', 'petropolis']],
  ['MG', 12, ['belo horizonte', 'uberlandia', 'juiz de fora']],
  ['RS', 6, ['porto alegre', 'caxias do sul', 'pelotas']],
  ['PR', 6, ['curitiba', 'londrina', 'maringa']],
  ['SC', 4, ['florianopolis', 'joinville', 'blumenau']],
  ['BA', 4, ['salvador', 'feira de santana']],
  ['DF', 3, ['brasilia']],
  ['ES', 2, ['vitoria', 'vila velha']],
  ['GO', 2, ['goiania']],
  ['PE', 3, ['recife']],
  ['CE', 3, ['fortaleza']],
];

const COMMENTS = [
  'Chegou antes do prazo, recomendo', 'Produto de boa qualidade', 'Entrega demorou mais do que o esperado',
  'Nao recebi o produto completo', 'Muito bom, super recomendo', 'Produto veio com defeito',
  'Atendimento excelente', 'Great product, fast delivery', 'Packaging was damaged', 'Exactly as described',
];

export interface GenerateOptions {
  seed?: number;
  uniqueCustomers?: number;
  orders?: number;
  sellers?: number;
  products?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
function fmt(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function generateDataset(opts: GenerateOptions = {}): Dataset {
  const rng = mulberry32(opts.seed ?? 42);
  const nUnique = opts.uniqueCustomers ?? 3000;
  const nOrders = opts.orders ?? 3600;
  const nSellers = opts.sellers ?? 120;
  const nProducts = opts.products ?? 700;

  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const weighted = <T,>(items: [T, number][]): T => {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = rng() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r <= 0) return v;
    }
    return items[items.length - 1]![0];
  };
  const hex = () => {
    let s = '';
    while (s.length < 32) s += Math.floor(rng() * 16).toString(16);
    return s;
  };
  const round2 = (x: number) => Math.round(x * 100) / 100;

  // --- categories -------------------------------------------------------
  const product_category_name_translation: Row[] = CATEGORIES.map(([pt, en]) => [pt, en]);
  const catWeights: [string, number][] = CATEGORIES.map(([pt, , w]) => [pt, w]);

  // --- sellers ----------------------------------------------------------
  const sellers: Row[] = [];
  for (let i = 0; i < nSellers; i++) {
    const [state, , cities] = weighted<(typeof STATES)[number]>(STATES.map((s) => [s, s[1] * (s[0] === 'SP' ? 1.5 : 1)] as [(typeof STATES)[number], number]));
    sellers.push([hex(), String(int(1000, 99999)).padStart(5, '0'), pick(cities), state]);
  }

  // --- products (each product has one seller and a base price) -----------
  const products: Row[] = [];
  const productSeller: string[] = [];
  const productPrice: number[] = [];
  const productWeight: number[] = [];
  for (let i = 0; i < nProducts; i++) {
    const cat = weighted(catWeights);
    const weight = int(100, 12000);
    const base = round2(Math.exp(Math.log(12) + rng() * Math.log(70)) * (0.7 + rng() * 0.6));
    products.push([
      hex(), cat, int(20, 70), int(150, 2500), int(1, 8), weight, int(15, 80), int(5, 50), int(10, 60),
    ]);
    productSeller.push(sellers[int(0, nSellers - 1)]![0] as string);
    productPrice.push(base);
    productWeight.push(weight);
  }

  // --- customers & orders ------------------------------------------------
  const uniques = Array.from({ length: nUnique }, () => {
    const [state, , cities] = weighted<(typeof STATES)[number]>(STATES.map((s) => [s, s[1]] as [(typeof STATES)[number], number]));
    return { uid: hex(), zip: String(int(1000, 99999)).padStart(5, '0'), city: pick(cities), state };
  });

  // Months Jan 2017 .. Aug 2018 with growth and a Nov 2017 spike.
  const months: [number, number][] = [];
  for (let m = 0; m < 20; m++) months.push([2017 + Math.floor(m / 12), m % 12]);
  const monthWeights: [number, number][] = months.map((_, i) => [i, 1 + i * 0.9 + (i === 10 ? 12 : 0)]);

  const customers: Row[] = [];
  const orders: Row[] = [];
  const order_items: Row[] = [];
  const order_payments: Row[] = [];
  const order_reviews: Row[] = [];

  const END = Date.UTC(2018, 7, 29, 23, 59, 59);
  const customerOrderCount = new Array<number>(nUnique).fill(0);

  for (let o = 0; o < nOrders; o++) {
    // First pass gives every person one order; later orders favour a minority of repeat buyers.
    const u = o < nUnique ? o : Math.floor(Math.pow(rng(), 2.2) * nUnique);
    const person = uniques[u]!;
    customerOrderCount[u]!++;

    const customerId = hex();
    customers.push([customerId, person.uid, person.zip, person.city, person.state]);

    const [y, mo] = months[weighted(monthWeights)]!;
    const day = int(1, 28 + (mo === 0 || mo === 2 || mo === 4 || mo === 6 || mo === 7 || mo === 9 || mo === 11 ? 3 : 2));
    let purchase = Date.UTC(y, mo, Math.min(day, 28), int(0, 23), int(0, 59), int(0, 59));
    if (day > 28) purchase += (day - 28) * 86_400_000;
    if (purchase > END) purchase = END - int(0, 20 * 86_400_000);

    const orderId = hex();
    const roll = rng();
    const status =
      roll < 0.965 ? 'delivered' : roll < 0.975 ? 'canceled' : roll < 0.98 ? 'unavailable' : roll < 0.988 ? 'shipped'
        : roll < 0.993 ? 'invoiced' : roll < 0.997 ? 'processing' : roll < 0.999 ? 'approved' : 'created';
    // Orders from the last two weeks of the data cannot be delivered yet.
    const recent = END - purchase < 14 * 86_400_000;
    const finalStatus = recent && status === 'delivered' ? (rng() < 0.5 ? 'shipped' : 'processing') : status;

    const approved = finalStatus === 'created' ? null : purchase + int(10, 900) * 60_000;
    const carrier = ['delivered', 'shipped'].includes(finalStatus) ? purchase + int(1, 4) * 86_400_000 + int(0, 86_000) * 1000 : null;
    const estimated = purchase + int(15, 32) * 86_400_000;
    const late = rng() < 0.08;
    const deliveredAt = finalStatus === 'delivered'
      ? purchase + (late ? int(estimated - purchase + 86_400_000, estimated - purchase + 10 * 86_400_000) : int(3 * 86_400_000, Math.max(4 * 86_400_000, estimated - purchase - 86_400_000)))
      : null;

    orders.push([
      orderId, customerId, finalStatus, fmt(new Date(purchase)),
      approved ? fmt(new Date(approved)) : null,
      carrier ? fmt(new Date(carrier)) : null,
      deliveredAt ? fmt(new Date(deliveredAt)) : null,
      fmt(new Date(estimated)),
    ]);

    // items
    const nItems = weighted<number>([[1, 70], [2, 18], [3, 7], [4, 5]]);
    let orderTotal = 0;
    for (let i = 1; i <= nItems; i++) {
      const p = Math.min(nProducts - 1, Math.floor(Math.pow(rng(), 2.2) * nProducts));
      const price = round2(productPrice[p]! * (0.92 + rng() * 0.16));
      const freight = round2(7 + productWeight[p]! / 1000 * 2.4 + rng() * 14);
      orderTotal += price + freight;
      order_items.push([orderId, i, products[p]![0] as string, productSeller[p]!, fmt(new Date(purchase + 4 * 86_400_000)), price, freight]);
    }
    orderTotal = round2(orderTotal);

    // payments: usually one; sometimes a voucher plus another method
    const split = rng() < 0.15;
    const mainType = weighted<string>([['credit_card', 74], ['boleto', 19], ['voucher', 5], ['debit_card', 2]]);
    if (!split) {
      order_payments.push([orderId, 1, mainType, mainType === 'credit_card' ? weighted<number>([[1, 50], [2, 12], [3, 12], [4, 8], [6, 6], [10, 12]]) : 1, orderTotal]);
    } else {
      const voucher = round2(Math.min(orderTotal * (0.1 + rng() * 0.4), orderTotal - 1));
      order_payments.push([orderId, 1, 'voucher', 1, voucher]);
      order_payments.push([orderId, 2, mainType === 'voucher' ? 'credit_card' : mainType, 1, round2(orderTotal - voucher)]);
    }

    // review
    if (finalStatus === 'delivered' && rng() < 0.95) {
      const score = late
        ? weighted<number>([[1, 34], [2, 14], [3, 17], [4, 17], [5, 18]])
        : weighted<number>([[1, 6], [2, 2], [3, 8], [4, 20], [5, 64]]);
      const created = deliveredAt! + 86_400_000;
      const hasMsg = rng() < 0.3;
      order_reviews.push([
        hex(), orderId, score, hasMsg && rng() < 0.4 ? 'Review' : null, hasMsg ? pick(COMMENTS) : null,
        fmt(new Date(created)), fmt(new Date(created + int(1, 5) * 86_400_000)),
      ]);
    }
  }

  return { customers, sellers, product_category_name_translation, products, orders, order_items, order_payments, order_reviews };
}
