-- AskDB warehouse: an Olist-shaped e-commerce schema.
-- Same table and column names as the public Olist dataset (Kaggle, "Brazilian E-Commerce Public Dataset by Olist"),
-- except two renamed columns (product_name_length, product_description_length: the Kaggle files spell them "lenght").
-- The geolocation table is not included.

DROP SCHEMA IF EXISTS analytics CASCADE;
CREATE SCHEMA analytics;
SET search_path = analytics;

CREATE TABLE customers (
  customer_id              text PRIMARY KEY,   -- one per ORDER in Olist (a returning person gets a new id each time)
  customer_unique_id       text NOT NULL,      -- identifies the PERSON across orders
  customer_zip_code_prefix text,
  customer_city            text,
  customer_state           text
);

CREATE TABLE sellers (
  seller_id              text PRIMARY KEY,
  seller_zip_code_prefix text,
  seller_city            text,
  seller_state           text
);

CREATE TABLE product_category_name_translation (
  product_category_name         text PRIMARY KEY,
  product_category_name_english text NOT NULL
);

CREATE TABLE products (
  product_id                 text PRIMARY KEY,
  product_category_name      text REFERENCES product_category_name_translation (product_category_name),
  product_name_length        integer,
  product_description_length integer,
  product_photos_qty         integer,
  product_weight_g           integer,
  product_length_cm          integer,
  product_height_cm          integer,
  product_width_cm           integer
);

CREATE TABLE orders (
  order_id                       text PRIMARY KEY,
  customer_id                    text NOT NULL REFERENCES customers (customer_id),
  order_status                   text NOT NULL,
  order_purchase_timestamp       timestamp NOT NULL,
  order_approved_at              timestamp,
  order_delivered_carrier_date   timestamp,
  order_delivered_customer_date  timestamp,
  order_estimated_delivery_date  timestamp
);

CREATE TABLE order_items (
  order_id            text NOT NULL REFERENCES orders (order_id),
  order_item_id       integer NOT NULL,
  product_id          text NOT NULL REFERENCES products (product_id),
  seller_id           text NOT NULL REFERENCES sellers (seller_id),
  shipping_limit_date timestamp,
  price               numeric(12, 2) NOT NULL,
  freight_value       numeric(12, 2) NOT NULL,
  PRIMARY KEY (order_id, order_item_id)
);

CREATE TABLE order_payments (
  order_id             text NOT NULL REFERENCES orders (order_id),
  payment_sequential   integer NOT NULL,
  payment_type         text NOT NULL,
  payment_installments integer NOT NULL,
  payment_value        numeric(12, 2) NOT NULL,
  PRIMARY KEY (order_id, payment_sequential)
);

CREATE TABLE order_reviews (
  review_id               text NOT NULL,
  order_id                text NOT NULL REFERENCES orders (order_id),
  review_score            integer NOT NULL,
  review_comment_title    text,
  review_comment_message  text,
  review_creation_date    timestamp,
  review_answer_timestamp timestamp
);

CREATE INDEX orders_customer_idx   ON orders (customer_id);
CREATE INDEX orders_purchase_idx   ON orders (order_purchase_timestamp);
CREATE INDEX items_product_idx     ON order_items (product_id);
CREATE INDEX items_seller_idx      ON order_items (seller_id);
CREATE INDEX reviews_order_idx     ON order_reviews (order_id);
CREATE INDEX customers_unique_idx  ON customers (customer_unique_id);
