-- PRODUCTION triggers on orders / sales_orders — NOT a migration. Captured read-only from production
-- (pg_get_triggerdef / pg_get_functiondef, 2026-10-20, runbook step P4b); bodies verbatim. Not in this repo's
-- migrations (applied outside them). Used by scripts/test-123-with-production-triggers-pg.js.

CREATE OR REPLACE FUNCTION public.fn_lock_on_deliver()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status IN ('delivered', 'Delivered')
     AND OLD.status NOT IN ('delivered', 'Delivered') THEN
    NEW.is_locked  = TRUE;
    NEW.locked_at  = NOW();
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_orders_lock_on_deliver BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION fn_lock_on_deliver();

CREATE OR REPLACE FUNCTION public.fn_touch_orders_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION fn_touch_orders_updated_at();

CREATE OR REPLACE FUNCTION public.sales_orders_auto_archive_on_delivered()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'delivered'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'delivered')
     AND NEW.archived_at IS NULL THEN
    NEW.archived_at      := now();
    NEW.archived_by      := NULL;
    NEW.archived_by_name := NULL;
    NEW.archive_reason   := 'auto_delivered';
  ELSIF TG_OP = 'UPDATE'
     AND OLD.status = 'delivered'
     AND NEW.status IS DISTINCT FROM 'delivered'
     AND NEW.archive_reason = 'auto_delivered' THEN
    NEW.archived_at      := NULL;
    NEW.archived_by      := NULL;
    NEW.archived_by_name := NULL;
    NEW.archive_reason   := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_sales_orders_auto_archive BEFORE INSERT OR UPDATE OF status ON public.sales_orders FOR EACH ROW EXECUTE FUNCTION sales_orders_auto_archive_on_delivered();

CREATE OR REPLACE FUNCTION public.sync_so_delivery_date_to_orders()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.delivery_date IS DISTINCT FROM OLD.delivery_date THEN
    UPDATE orders
       SET delivery_date = NEW.delivery_date
     WHERE so_number = NEW.order_number
       AND company_id = NEW.company_id
       AND COALESCE(delivery_date, '') IS DISTINCT FROM COALESCE(NEW.delivery_date, '');
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_sync_so_delivery_date AFTER INSERT OR UPDATE OF delivery_date ON public.sales_orders FOR EACH ROW EXECUTE FUNCTION sync_so_delivery_date_to_orders();
