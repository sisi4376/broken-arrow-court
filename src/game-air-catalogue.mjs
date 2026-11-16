import {compileAirUnit,AIR_MODEL_VERSION} from './air-superiority.mjs';

// Reproduce the normalized catalogue's joins from the original game tables.
export function compileGameAirCatalogue(tables,{versionName,buildId,validFrom}={}){
  const indexed=name=>{
    const rows=tables[name];
    if(!Array.isArray(rows)||rows.some(r=>!Number.isSafeInteger(r.Id)||r.Id<0)||new Set(rows.map(r=>r.Id)).size!==rows.length)throw Error(`${name} 表 ID 缺失或重复`);
    return new Map(rows.map(r=>[r.Id,r]));
  };
  const units=indexed('Units'),mods=indexed('Modifications'),options=indexed('Options'),turrets=indexed('Turrets'),links=indexed('TurretUnits'),weapons=indexed('Weapons'),mounts=indexed('TurretWeapons'),ammo=indexed('WeaponAmmunitions');
  const result={version:AIR_MODEL_VERSION,version_name:versionName,db_file:'game-build-'+buildId,valid_from:validFrom,units:{},roles:{}};
  for(const u of units.values()){
    if(!Number.isSafeInteger(u.Role)||u.Role<0)throw Error(`单位 ${u.Id} 缺少角色`);
    result.roles[u.Id]=u.Role;if(u.Role<160||u.Role>164)continue;
    const modifications=[...mods.values()].filter(m=>m.UnitId===u.Id).map(m=>({id:m.Id,name:m.Name,options:[...options.values()].filter(o=>o.ModificationId===m.Id).map(o=>({id:o.Id,name:o.Name,uiName:o.UIName,replaceUnitId:o.ReplaceUnitId??0,
      ...Object.fromEntries(Array.from({length:21},(_,i)=>[`turret${i}Id`,o[`Turret${i}Id`]>0?o[`Turret${i}Id`]:null]))}))}));
    const ids=new Set([...links.values()].filter(t=>t.UnitId===u.Id).map(t=>t.TurretId));
    for(const m of modifications)for(const o of m.options)for(let i=0;i<=20;i++)if(o[`turret${i}Id`]>0)ids.add(o[`turret${i}Id`]);
    const normalized=[...ids].map(id=>{
      const t=turrets.get(id);if(!t)throw Error(`飞机 ${u.Id} 缺少炮塔 ${id}`);
      return {turret:{id,isDefault:t.IsDefault,weapons:[...mounts.values()].filter(w=>w.TurretId===id).map(link=>{
        const w=weapons.get(link.WeaponId);if(!w)throw Error(`炮塔 ${id} 缺少武器 ${link.WeaponId}`);
        return {weapon:{type:w.Type,ammunition:[...ammo.values()].filter(a=>a.UnitId===u.Id&&a.WeaponId===w.Id).map(a=>({quantity:a.Quantity}))}};
      })}};
    });
    result.units[u.Id]=compileAirUnit({id:u.Id,role:u.Role,hudName:u.HUDName,name:u.Name,turrets:normalized,modifications});
    if(Object.values(result.units[u.Id].turrets).some(t=>!t.valid))throw Error(`飞机 ${u.Id} 武器类型或弹药记录不完整`);
  }
  return result;
}
