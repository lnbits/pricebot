use crate::lnbits::extension::host as wit;
use serde_json::Value;

pub fn now() -> u64 {
    wit::now().timestamp
}

pub fn id(prefix: &str) -> String {
    wit::random_id(&wit::RandomIdRequest {
        prefix: prefix.into(),
    })
    .id
}

pub fn log(message: &str, level: &str) {
    wit::log(&wit::LogRequest {
        level: level.into(),
        message: message.into(),
    });
}

pub fn get(table: &str, id: &str) -> Result<Value, String> {
    let r = wit::storage_get(&wit::StorageGetRequest {
        table: table.into(),
        id: id.into(),
    });
    match r.data_json {
        None => Ok(Value::Null),
        Some(s) => serde_json::from_str(&s).map_err(|_| "Invalid stored row.".into()),
    }
}

pub fn get_public(table: &str, id: &str) -> Result<Value, String> {
    let r = wit::storage_get_public(&wit::StorageGetRequest {
        table: table.into(),
        id: id.into(),
    });
    match r.data_json {
        None => Ok(Value::Null),
        Some(s) => serde_json::from_str(&s).map_err(|_| "Invalid stored row.".into()),
    }
}

pub fn set(table: &str, row: &Value) -> Result<(), String> {
    let r = wit::storage_set(&wit::StorageSetRequest {
        table: table.into(),
        data_json: row.to_string(),
    });
    if r.ok {
        Ok(())
    } else {
        Err("Could not save row.".into())
    }
}

pub fn delete(table: &str, id: &str) -> Result<(), String> {
    let r = wit::storage_delete(&wit::StorageGetRequest {
        table: table.into(),
        id: id.into(),
    });
    if r.ok {
        Ok(())
    } else {
        Err("Could not delete row.".into())
    }
}

pub struct Page {
    pub rows: Vec<Value>,
    pub total: u64,
}

pub fn page(table: &str, options: Value) -> Result<Page, String> {
    let r = wit::storage_get_paginated(&wit::StoragePaginatedRequest {
        table: table.into(),
        filters_json: options
            .get("filters")
            .map(Value::to_string)
            .unwrap_or_else(|| "{}".into()),
        search: options["search"].as_str().unwrap_or_default().into(),
        search_fields: options["searchFields"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
        sort_by: options["sortBy"].as_str().unwrap_or_default().into(),
        descending: options["descending"] == true,
        limit: options["limit"].as_u64().unwrap_or(25) as u32,
        offset: options["offset"].as_u64().unwrap_or(0) as u32,
    });
    Ok(Page {
        rows: serde_json::from_str(&r.rows_json).map_err(|_| "Invalid stored rows.")?,
        total: r.total,
    })
}

pub fn public_page(table: &str, source: &str, options: Value) -> Result<Page, String> {
    let r = wit::storage_get_public_paginated(&wit::StoragePublicPaginatedRequest {
        table: table.into(),
        source_id: source.into(),
        filters_json: options
            .get("filters")
            .map(Value::to_string)
            .unwrap_or_else(|| "{}".into()),
        search: options["search"].as_str().unwrap_or_default().into(),
        search_fields: options["searchFields"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
        sort_by: options["sortBy"].as_str().unwrap_or_default().into(),
        descending: options["descending"] == true,
        limit: options["limit"].as_u64().unwrap_or(25) as u32,
        offset: options["offset"].as_u64().unwrap_or(0) as u32,
    });
    Ok(Page {
        rows: serde_json::from_str(&r.rows_json).map_err(|_| "Invalid stored rows.")?,
        total: r.total,
    })
}
