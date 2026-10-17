import type { GuardPolicy } from '../src/guard';

/** Same policy the app derives from the catalog + schema_docs.yaml, hard-coded so these tests need no database. */
export const policy: GuardPolicy = {
  allowedTables: new Set([
    'customers', 'sellers', 'product_category_name_translation', 'products',
    'orders', 'order_items', 'order_payments', 'order_reviews',
  ]),
  schema: 'analytics',
  piiColumns: new Set(['customer_zip_code_prefix', 'seller_zip_code_prefix', 'review_comment_title', 'review_comment_message']),
  tablesWithPii: new Set(['customers', 'sellers', 'order_reviews']),
};
