require('dotenv').config();
global.WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

// Aumentar el límite de tamaño para permitir subir fotos en Base64
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Inicialización del cliente de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERROR FATAL: No se encontraron las variables SUPABASE_URL y/o SUPABASE_SERVICE_KEY en las variables de entorno.");
}

// ==========================================
// Fetch con reintentos automáticos.
// El plan gratuito de Supabase (instancia "Nano") a veces tarda
// en responder justo después de despertar de una pausa, causando
// "fetch failed" por timeout. Reintentamos hasta 2 veces con una
// pequeña espera antes de rendirnos, para que esos hipos de red
// no lleguen a mostrarse como error 500 al usuario final.
// ==========================================
async function fetchConReintentos(url, options, intentos = 3) {
    for (let i = 1; i <= intentos; i++) {
        try {
            return await fetch(url, options);
        } catch (err) {
            console.warn(`Intento ${i}/${intentos} falló al conectar con Supabase: ${err.message}`);
            if (i === intentos) throw err;
            await new Promise(r => setTimeout(r, 800 * i)); // espera creciente: 0.8s, 1.6s
        }
    }
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    global: { fetch: fetchConReintentos }
});

// Servir archivos HTML estáticos (administracion.html, clientes.html, etc.)
app.use(express.static(path.join(__dirname)));

// ==========================================
// MAPEO camelCase (frontend) <-> snake_case (Supabase)
// Postgres guarda los nombres de columna en minúsculas si no se
// crean entre comillas dobles, por eso "horaBloqueo" y "notaAdmin"
// deben traducirse a "hora_bloqueo" y "nota_admin" al hablar con la BD.
// ==========================================
function inventarioToDB(body) {
    return {
        nombre: body.nombre,
        cantidad: body.cantidad,
        bloqueado: body.bloqueado,
        hora_bloqueo: body.horaBloqueo ?? null
    };
}

function inventarioFromDB(row) {
    return {
        id: row.id,
        nombre: row.nombre,
        cantidad: row.cantidad,
        bloqueado: row.bloqueado,
        horaBloqueo: row.hora_bloqueo
    };
}

// ==========================================
// RUTAS DE INVENTARIO
// ==========================================
app.get('/api/inventario', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('inventario')
            .select('*');

        if (error) throw error;
        res.status(200).json(data.map(inventarioFromDB));
    } catch (error) {
        console.error("Error al obtener inventario:", error.message);
        res.status(500).json({ error: "Error interno al leer inventario" });
    }
});

app.post('/api/inventario', async (req, res) => {
    try {
        const { nombre, cantidad } = req.body;

        const { data, error } = await supabase
            .from('inventario')
            .insert([inventarioToDB({
                nombre,
                cantidad: cantidad || 0,
                bloqueado: false,
                horaBloqueo: null
            })])
            .select();

        if (error) throw error;
        res.status(201).json({ success: true, id: data[0].id });
    } catch (error) {
        console.error("Error al crear producto:", error.message);
        res.status(500).json({ error: "Error interno al crear producto" });
    }
});

app.post('/api/inventario/modificar', async (req, res) => {
    try {
        const { nombre, cantidad, operacion } = req.body;

        // Buscar el producto por nombre
        const { data: producto, error: searchError } = await supabase
            .from('inventario')
            .select('*')
            .eq('nombre', nombre)
            .maybeSingle();

        if (searchError || !producto) {
            return res.status(404).json({ error: "Producto no encontrado" });
        }

        let nuevoStock = producto.cantidad || 0;
        if (operacion === 'sumar') nuevoStock += parseInt(cantidad, 10);
        if (operacion === 'restar') nuevoStock -= parseInt(cantidad, 10);

        // Actualizar el stock calculado
        const { error: updateError } = await supabase
            .from('inventario')
            .update({ cantidad: nuevoStock })
            .eq('nombre', nombre);

        if (updateError) throw updateError;
        res.status(200).json({ success: true, nuevoStock });
    } catch (error) {
        console.error("Error al modificar stock:", error.message);
        res.status(500).json({ error: "Error interno al modificar stock" });
    }
});

app.post('/api/inventario/bloquear', async (req, res) => {
    try {
        const { nombre, bloqueado, horaBloqueo } = req.body;

        const { data, error } = await supabase
            .from('inventario')
            .update({ bloqueado, hora_bloqueo: horaBloqueo })
            .eq('nombre', nombre)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.status(404).json({ error: "Producto no encontrado" });
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error al bloquear producto:", error.message);
        res.status(500).json({ error: "Error interno al bloquear" });
    }
});

// ==========================================
// RUTAS DE PEDIDOS Y CUENTAS
// ==========================================
app.get('/api/pedidos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pedidos')
            .select('*')
            .order('fecha', { ascending: false })
            .limit(100);

        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        console.error("Error al obtener pedidos:", error.message);
        res.status(500).json({ error: "Error al cargar pedidos" });
    }
});

app.post('/api/pedidos', async (req, res) => {
    try {
        const pedidoData = { ...req.body, fecha: new Date().toISOString() };

        const { data, error } = await supabase
            .from('pedidos')
            .insert([pedidoData])
            .select();

        if (error) throw error;
        res.status(201).json({ success: true, id: data[0].id });
    } catch (error) {
        console.error("Error al guardar pedido:", error.message);
        res.status(500).json({ error: "Error interno al guardar el pedido" });
    }
});

app.put('/api/pedidos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const { error } = await supabase
            .from('pedidos')
            .update(updates)
            .eq('id', id);

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error al actualizar pedido:", error.message);
        res.status(500).json({ error: "Error al actualizar" });
    }
});

app.get('/api/cuentas', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pedidos')
            .select('*');

        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        console.error("Error al obtener cuentas:", error.message);
        res.status(500).json({ error: "Error al cargar cuentas" });
    }
});

app.put('/api/cuentas/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { notaAdmin, ...resto } = req.body;
        const datosAActualizar = { ...resto };
        if (notaAdmin !== undefined) datosAActualizar.nota_admin = notaAdmin;

        const { data, error } = await supabase
            .from('pedidos')
            .update(datosAActualizar)
            .eq('id', id)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.status(404).json({ error: "La cuenta no fue encontrada en la base de datos" });
        }

        res.status(200).json({ success: true, message: "Cuenta cobrada y actualizada correctamente" });
    } catch (error) {
        console.error("Error al modificar cuenta:", error.message);
        res.status(500).json({ error: "Error interno al modificar la cuenta" });
    }
});

app.delete('/api/cuentas/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabase
            .from('pedidos')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error al eliminar cuenta:", error.message);
        res.status(500).json({ error: "Error al eliminar" });
    }
});

// ==========================================
// RUTA PARA OBTENER COMPROBANTE
// ==========================================
app.get('/api/comprobantes/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { data, error } = await supabase
            .from('pedidos')
            .select('comprobante_adjunto')
            .eq('id', id)
            .maybeSingle();

        if (error || !data) return res.status(404).json({ error: "No encontrado" });

        res.status(200).json({ imagen: data.comprobante_adjunto || null });
    } catch (error) {
        console.error("Error al obtener comprobante:", error.message);
        res.status(500).json({ error: "Error al cargar imagen" });
    }
});

// ==========================================
// CONFIGURACIÓN DE TARJETA
// ==========================================
app.get('/api/config/tarjeta', async (req, res) => {
    res.status(200).json({ numero: "1234 5678 9012 3456" });
});

// ==========================================
// MANEJO DE RUTAS NO ENCONTRADAS Y ERRORES GLOBALES
// ==========================================
app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((err, req, res, next) => {
    console.error("💥 ERROR NO MANEJADO:", err);
    res.status(500).json({ error: "Error interno del servidor" });
});

// Exportar app para entorno Serverless / Vercel
module.exports = app;

// Escuchar servidor en entorno local o producción tradicional
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`✅ Servidor Supabase corriendo en el puerto ${port}`);
});


