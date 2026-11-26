/**
 * spanish-query.ts — Bounded Spanish -> English software/domain lexical bridge.
 *
 * Keys are strictly unambiguous Spanish words (never valid English words or
 * code identifiers), so English queries and backticked/path tokens remain
 * byte-identical. Appends at most 16 English search hints.
 */

const SPANISH_SEARCH_TERMS = new Map<string, string[]>([
    // Billing, commerce & scheduling (keep initial order stable for existing budget caps)
    ["factura facturas facturacion", "invoice billing"],
    ["redondeo redondear redondea", "rounding"],
    ["importe importes monto montos", "amount"],
    ["precio precios", "price"],
    ["descuento descuentos", "discount"],
    ["impuesto impuestos iva", "tax vat"],
    ["pago pagos cobro cobros", "payment charge"],
    ["saldo saldos", "balance"],
    ["envio envios", "shipping freight"],
    ["pedido pedidos", "order"],
    ["cliente clientes", "customer"],
    ["inventario existencias", "inventory stock"],
    ["reserva reservas", "booking reservation"],
    ["cita citas", "appointment slot"],
    ["calendario calendarios", "calendar"],
    ["recordatorio recordatorios", "reminder"],
    ["cancelada canceladas cancelado cancelados", "cancelled canceled voided"],
    ["solapamiento solapamientos superposicion", "overlap conflicting"],
    ["agendar horario horarios", "schedule slot"],
    ["carrito carritos", "cart"],
    ["vencido vencidos vencida vencidas abandonado abandonados", "expired abandoned"],
    // Auth, security, secrets & PII redaction
    ["autenticacion", "authentication"],
    ["autorizacion", "authorization"],
    ["contrasena contrasenas", "password"],
    ["clave claves", "key"],
    ["secreto secretos", "secret"],
    ["privada privadas privado privados", "private"],
    ["credencial credenciales", "credential secret"],
    ["ocultar oculta borra borrar redactar redacta enmascarar", "redact sanitize"],
    ["correo correos", "email"],
    ["tarjeta tarjetas", "card"],
    ["traza trazas auditoria", "audit log"],
    ["usuario usuarios", "user"],
    ["sesion sesiones", "session"],
    ["permiso permisos", "permission"],
    ["caducidad expiracion", "expiration expiry"],
    ["verificacion", "verification factor"],
    // Compiler, linter, suppressions & terminal output
    ["compilador compiladores", "compiler"],
    ["silenciar silencie suprimir suprime ignorar ignora", "silencing suppress"],
    ["comentario comentarios directiva directivas", "comments directive"],
    ["errores fallo fallos fallan", "errors failure"],
    ["consola", "terminal"],
    ["ruido ruidoso ruidosa", "noise noisy"],
    ["recortar recorta", "truncate trim"],
    ["resumir", "summary"],
    // Infrastructure, webhooks, uploads, alerts & processes
    ["configuracion configuraciones", "configuration settings"],
    ["paginacion", "pagination"],
    ["busqueda busquedas", "search"],
    ["filtro filtros", "filter"],
    ["ordenamiento ordenacion", "sorting"],
    ["validacion validaciones", "validation"],
    ["serializacion", "serialization"],
    ["reintento reintentos", "retry"],
    ["concurrencia", "concurrency"],
    ["bloqueo bloqueos", "lock"],
    ["transaccion transacciones", "transaction"],
    ["duplicado duplicados duplicada duplicadas", "duplicate idempotency"],
    ["pasarela pasarelas", "gateway"],
    ["notificacion notificaciones", "notification"],
    ["adjunto adjuntos", "attachment"],
    ["subida subir", "upload"],
    ["firmado firmados firmada firmadas", "presigned signed"],
    ["alerta alertas", "alert"],
    ["simbolico simbolicos simbolica simbolicas", "symbolic symlink"],
    ["huerfano huerfanos", "orphan"],
    // Subscriptions, proration, refunds, attendance & timezones (appended after initial 16-cap ordering)
    ["prorrateo prorratear prorrateado prorrateada", "proration prorate"],
    ["suscripcion suscripciones mensualidad abono", "subscription"],
    ["reembolso reembolsos devolucion devoluciones", "refund"],
    ["cupon cupones", "coupon voucher"],
    ["espera", "waitlist queue"],
    ["asistencia asistencias asistente asistentes", "attendance attendee"],
    ["cupo cupos aforo", "capacity seat spot"],
    ["semana semanas semanal semanales", "week weekly"],
    ["mensual mensuales anual anuales", "monthly annual"],
    ["zona zonas huso horaria horarias", "timezone zone"],
    ["plantilla plantillas", "template"],
    ["enlace enlaces vinculo", "link"],
    ["cuenta cuentas", "account"],
    ["tarifa tarifas cuota cuotas", "rate fee quota"],
    // Warehouse, packaging, availability & dispatch (appended: earlier caps unchanged)
    ["caja cajas empaque empaques embalaje", "case pack package"],
    ["bodega bodegas almacen almacenes", "warehouse"],
    ["disponible disponibles disponibilidad", "available availability"],
    ["reservada reservadas reservado reservados", "reserved"],
    ["retenida retenidas retenido retenidos retencion", "held hold"],
    ["mercaderia mercancia sobrante sobrantes", "merchandise remainder"],
    ["unidad unidades", "unit units"],
    ["despacho despachos despachar despachada", "dispatch ship"],
    ["entrega entregas", "delivery"],
    ["transito", "transit"],
    ["feriado feriados festivo festivos", "holiday"],
    ["habil habiles laborable laborables", "business working"],
    ["dia dias", "day days"],
    ["corte", "cutoff"],
].flatMap(([forms, english]) => forms.split(" ").map(form => [form, english.split(" ")] as const)));

/** Preserve the task and its exact names; append at most 16 distinct lexical hints. */
export function expandSpanishContextQuery(query: string): string {
    const prose = query.replace(/`[^`\n]*`|[\w.-]*[/\\][\w./\\-]*/g, " ")
        .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const words = new Set(prose.match(/[a-z_$][a-z0-9_$]*/g) ?? []);
    const added = new Set<string>();
    for (const word of words) {
        for (const hint of SPANISH_SEARCH_TERMS.get(word) ?? []) {
            if (!words.has(hint) && added.size < 16) added.add(hint);
        }
    }
    return added.size > 0 ? `${query} ${[...added].join(" ")}` : query;
}
