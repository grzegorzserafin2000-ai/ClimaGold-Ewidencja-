(function () {
  'use strict';
  var opened = false;
  function node(tag, text, cls) { var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n; }
  function equal(a,b){return JSON.stringify(a)===JSON.stringify(b);}
  function dates(d,t){return [d,t].filter(Boolean).join(' ')||'—';}
  function days(a){return (a||[]).map(function(d){return d.date+': '+(d.system||'wolne')+(d.breaks&&d.breaks.length?' (przerwy: '+d.breaks.join(', ')+')':'');}).join('\n')||'—';}
  function participation(a){return (a||[]).map(function(r){return (r.employee||'Pracownik')+'\nDołącza: '+dates(r.work_from_date,r.work_from_time)+'\nKończy: '+dates(r.work_to_date,r.work_to_time)+'\n'+days(r.days)+'\nWstrzymania: '+((r.pauses||[]).map(function(p){return dates(p.from_date,p.from_time)+' → '+dates(p.to_date,p.to_time);}).join('; ')||'brak');}).join('\n\n')||'—';}
  function fields(e){e=e||{};return [
    ['Numer',e.number||'—'],['Typ urządzenia',e.device_type||'—'],
    ['Rozpoczęcie',dates(e.start_date,e.start_time)],['Zakończenie',dates(e.end_date,e.end_time)],
    ['Pracownicy',(e.employees||[]).join(', ')||'—'],['Pracownicy dodatkowi',(e.additional_employees||[]).join(', ')||'—'],
    ['Korekty czasu',(e.corrections||[]).map(function(c,i){return ((e.employees||[])[i]||'Pracownik '+(i+1))+': '+c;}).join('\n')||'—'],
    ['System pracy',days(e.day_systems)],['Udział i wstrzymania pracowników',participation(e.employee_systems)],
    ['Centrale w zestawie',(e.bundle_units||[]).map(function(u){return u.number+' — koniec: '+dates(u.end_date,u.end_time);}).join('\n')||'—'],
    ['Uwagi',e.notes||'—'],['Kolor',({yellow:'Żółty',green:'Zielony',red:'Czerwony',blue:'Niebieski',orange:'Pomarańczowy',purple:'Fioletowy'})[e.mark_color]||'Bez koloru']
  ];}
  window.cgUndoOpen=async function(){
    if(opened||!ME||(ME.role!=='admin'&&ME.role!=='supervisor'))return;
    opened=true;var opener=document.activeElement,overlay=node('div',undefined,'modal open cg-undo-modal'),dialog=node('div',undefined,'dialog'),busy=false;
    dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','cgUndoTitle');dialog.tabIndex=-1;
    var heading=node('h2','Cofnij ostatnią zmianę wpisu');heading.id='cgUndoTitle';dialog.appendChild(heading);
    var info=node('p','Sprawdzam ostatni zapis w tym dziale…','muted');dialog.appendChild(info);
    var details=node('div');dialog.appendChild(details);
    var actions=node('div',undefined,'entryactions'),cancel=node('button','Anuluj','btn secondary'),apply=node('button','Cofnij tę zmianę','btn');cancel.type=apply.type='button';apply.disabled=true;actions.appendChild(cancel);actions.appendChild(apply);dialog.appendChild(actions);overlay.appendChild(dialog);document.body.appendChild(overlay);dialog.focus();
    function close(){if(busy)return;overlay.remove();opened=false;if(opener&&opener.isConnected)opener.focus();}
    cancel.addEventListener('click',close);
    overlay.addEventListener('click',function(e){if(e.target===overlay)close();});
    overlay.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();close();}if(e.key==='Tab'){var a=[].slice.call(dialog.querySelectorAll('button:not(:disabled)'));if(!a.length)return;var first=a[0],last=a[a.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog)){e.preventDefault();last.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===dialog)){e.preventDefault();first.focus();}}});
    try{
      var result=await api('/api/entry/change-preview'),change=result.change;
      if(!overlay.isConnected)return;
      if(!change){info.textContent='Brak zapisanej zmiany do cofnięcia. Historia obejmuje 50 ostatnich zapisów wpisów wykonanych od wprowadzenia tej funkcji.';apply.hidden=true;cancel.textContent='Zamknij';cancel.focus();return;}
      info.textContent='Ostatni zapis w tym dziale: '+new Date(change.at).toLocaleString('pl-PL')+' · '+change.by+'. Cofnięcie obejmie tylko wymienione poniżej wpisy.';
      change.entries.forEach(function(item){
        var entry=item.after||item.before||{},card=node('section',undefined,'card cg-undo-card');card.appendChild(node('h3',entry.number||'Wpis bez numeru'));
        if(!item.before){card.appendChild(node('p','Ten wpis został dodany. Cofnięcie usunie go z ewidencji.'));}
        else{
          var table=node('table',undefined,'cg-undo-table'),head=node('thead'),tr=node('tr');['Pole','Obecnie','Po cofnięciu'].forEach(function(t){tr.appendChild(node('th',t));});head.appendChild(tr);table.appendChild(head);var body=node('tbody'),a=fields(item.after),b=fields(item.before),count=0;
          a.forEach(function(row,i){if(row[1]===b[i][1])return;count++;var r=node('tr');r.appendChild(node('td',row[0]));r.appendChild(node('td',row[1]));r.appendChild(node('td',b[i][1]));body.appendChild(r);});
          table.appendChild(body);if(count)card.appendChild(table);else card.appendChild(node('p','Przywrócenie poprzednio zapisanego stanu wpisu.'));
        }
        details.appendChild(card);
      });
      if(change.blocked){details.appendChild(node('p',change.blocked,'error'));apply.hidden=true;cancel.textContent='Zamknij';}
      else apply.disabled=false;
      cancel.focus();
      apply.addEventListener('click',async function(){
        if(busy||apply.disabled)return;busy=true;apply.disabled=true;cancel.disabled=true;apply.textContent='Cofam…';
        try{await api('/api/entry/change-undo',{method:'POST',body:JSON.stringify({token:change.token})});
          apply.textContent='Cofnięto';apply.hidden=true;info.textContent='Zmiana została cofnięta.';details.textContent='';
          try{D=await api('/api/data');renderAll();}catch(refreshError){info.textContent='Zmiana została cofnięta. Odśwież stronę, aby zobaczyć aktualne dane.';}
          cancel.textContent='Zamknij';
        }catch(err){details.appendChild(node('p',err.message||'Nie udało się cofnąć zmiany.','error'));apply.hidden=true;cancel.textContent='Zamknij';}
        finally{busy=false;cancel.disabled=false;cancel.focus();}
      });
    }catch(err){if(overlay.isConnected){info.textContent=err.message||'Nie udało się pobrać historii. Sprawdź, czy serwer został zaktualizowany.';apply.hidden=true;cancel.textContent='Zamknij';}}
  };
})();
