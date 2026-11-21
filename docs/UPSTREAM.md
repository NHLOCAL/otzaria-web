# התאמה למקורות של תוכנת אוצריא

## כיצד נקבע מקור הספרים

הבחירה מבוססת על קוד ההתקנה והקריאה של תוכנת אוצריא עצמה. אין סריקה כללית של כל ריפו המכיל את המילה Otzaria ואין בחירה של אוסף ספרים לפי רשימה פרטית.

בסיס הבדיקה הוא [Otzaria/otzaria, commit `cee59520a8e6d35d5350b8f51cde322d4b4b99cf`](https://github.com/Otzaria/otzaria/tree/cee59520a8e6d35d5350b8f51cde322d4b4b99cf). זהו צילום של הענף הפעיל בעת מימוש היבוא. שינוי בחוזה ההפצה או בסכמת מסד הנתונים צריך לקבל התאמה בקוד ובבדיקות.

| רכיב בתוכנה | המקור שבקוד | התפקיד באתר |
| --- | --- | --- |
| מסד הספרים הראשי | `Otzaria/SeforimLibrary` Releases | כל הספרים, טקסטי הקריאה, הערות ומהדורות בעלות תוכן |
| צילומי התלמוד הבבלי המצורפים | `Otzaria/otzaria-library`, הנכס `talmud_bavli_latest.tar.zst` | קובצי PDF סטטיים וקישור מהמסכת המקבילה |
| קטלוג אוצר החכמה ו-HebrewBooks | `Otzaria/otzar-HB_catalog` | קטלוג חיצוני שהיישום משתמש בו; אינו טקסט הספרים של אוצריא |
| מילון לחיפוש המקורב | `Otzaria/SeforimMagicIndexer`, `lexical-v2.db` | רכיב של מנוע החיפוש המקומי; האתר בונה אינדקס Pagefind משלו |
| קבצים וספריות שהמשתמש מוסיף | תיקיות, מסדים ותוספים מקומיים | אינם חלק מההפצה הרשמית המשותפת |

הקטלוג החיצוני מכיל הפניות לספרים באתרים אחרים. הורדתו אינה מספקת את הטקסט המלא שלהם, ולכן הוא אינו מוצג באתר כאילו הועתקו לכאן ספרים נוספים. אין בכך החרגה של ספרי טקסט מתוך מסד אוצריא.

## ראיות ישירות מקוד היישום

### המסד הראשי

[`empty_library_bloc.dart`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/empty_library/bloc/empty_library_bloc.dart), בפונקציה `_fetchLatestDatabaseAsset`, פונה לכתובת:

```text
https://api.github.com/repos/Otzaria/SeforimLibrary/releases/latest
```

הפונקציה `parseLatestDatabaseAsset` בוחרת את הסכמה הגבוהה ביותר שהיישום תומך בה. באותה סכמה היא מעדיפה ארכיון יחיד, ואם הוא חסר משתמשת במניפסט של חלקים. `GithubLibraryReleaseClient.resolveSplitAsset` פותר את המניפסט לפני ההורדה.

[`database_constants.dart`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/data/constants/database_constants.dart) מגדיר `seforim.db` ואת `readableDbSchemaVersion = 7`. רשימת השמות התואמים היא סכמה 7, אחריה סכמה 6, ואז השם הישן `seforim.db.zst`.

היבוא לאתר מיישם את אותו סדר: סכמה 7, אחריה 6 ולבסוף 5 בשם הישן, ובכל סכמה ארכיון יחיד לפני מניפסט חלקים. סכמה חדשה שהיישום אינו מכיר אינה נבחרת. הוא מאמת את ההפצה, פרטי המקור, חלקי הארכיון או הארכיון היחיד לפני בניית הספרים. עצם קיום ריפו באותו ארגון אינו הבסיס להחלטה; ההפניה מתוך מתקין אוצריא היא הבסיס.

[`DbCapabilities`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/migration/database/db_capabilities.dart) מתעד את ההבדלים: בסכמה 6 ואילך התוכן נמצא ב-`line_content`; בסכמה 5 הוא נמצא ב-`line.content`. טבלאות הערות השוליים, באנרים והגבלות המו״ל נוספו בסכמה 7. כאשר טבלאות אלה אינן קיימות בסכמה קודמת, הערות שכבר נמצאות בתוך הטקסט נשמרות. בדיקות היבוא כוללות מסדים קטנים בסכמות 5 ו-6, נוסף על בדיקות הסכמה הנוכחית.

### צילומי הבבלי

[`companion_assets_service.dart`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/library_update/services/companion_assets_service.dart) מגדיר את מקור צילומי הבבלי ב-`Otzaria/otzaria-library`. הפונקציה `findLatestTalmudRelease` בודקת את ההפצה האחרונה; כאשר נכס הבבלי אינו נמצא בה, היא סורקת עד שלושה עמודים של 100 הפצות ומדלגת על prerelease.

זהו גם כלל הגילוי של `scripts/sync_companions.py`. הארכיון מאומת לפי גודל ו-SHA-256, כולל התאמה ל-`otzaria_release_provenance.json` כאשר קובץ המקור קיים. ה-PDF-ים נחלצים בזרימה לתיקייה זמנית, נבדקים, ורק לאחר השלמה מחליפים את תמונת המצב הקודמת.

התוכנה מגדירה את מזהי הקבצים המצורפים כ-`talmud-pdf:<title>`. [`talmud_bavli_open_format.dart`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/utils/navigation/talmud_bavli_open_format.dart) מזהה מסכת לפי שורש הקטגוריה `תלמוד בבלי`, ואחריו קטגוריית `סדר ...` אם ישנה. כך אין התאמה שגויה לפירוש בעל שם דומה. [`database_library_provider.dart`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/data/data_providers/database_library_provider.dart) משייך PDF לפי שם המסכת, ומציג קבצים ללא ספר טקסט מקביל בקבוצה נפרדת.

### מהדורות חלופיות

אותו provider קורא `book_version` ו-`version_line`. כדי לשמור על הנוסח ולא להמציא מילוי ממהדורה אחרת, סדר ההכרעה הוא:

1. שורת מבנה עם `line.heRef IS NULL` נשארת משורת הבסיס.
2. אם אין כלל שורה מתאימה ב-`version_line`, מוצג תוכן ריק באותו מקום.
3. אם שורת מהדורה קיימת אבל `content IS NULL`, התוכן זהה לשורת הבסיס.
4. אחרת משתמשים בתוכן השורה של המהדורה.

זוהי משמעות האחסון של סכמה 7, ולא פעולת `COALESCE` גורפת שעלולה לייחס טקסט ממוזג למהדורה שאינה מכילה אותו. לפי [`line_content_codec.dart`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/migration/database/line_content_codec.dart), תוכן BLOB בשורות הבסיס ובשורות המהדורה מפוענח בעזרת מילון zstd שמאוחסן במסד. ערכי TEXT נשארים טקסט.

אותו כלל חל גם בסכמה 6. בסכמה 5, תוכן `NULL` של שורת מהדורה הוא ריק ואינו מסמן שורה משותפת עם הבסיס. היבוא מבחין בין שתי המשמעויות בהתאם לסכמת האחסון, כפי שעושה הקורא המקורי.

### איורים בתוך הטקסט

[`OtzariaWidgetFactory`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/widgets/smart_text/otzaria_widget_factory.dart) מציג תמונות PNG ו-JPEG המוטמעות ב-`data:` מתוך בתיהן, באמצעות `MemoryImage`. התיאור הנגיש מגיע מ-`alt`, ובהיעדרו מ-`title`. [`SmartTextWidget`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/widgets/smart_text/smart_text_widget.dart) מעביר את טקסט הספר ל-`HtmlWidget` בלי `baseUrl` של מאגר תמונות חיצוני.

לכן איור שנמצא בטקסט של ההפצה הוא חלק מהתוכן. יש לחלץ את הבתים המוטמעים לקובץ סטטי, לשמור checksum ולשלב אותו באותו מקום בטקסט. כך נמנע ניפוח של כל עמוד HTML ומתקבל מטמון משותף לאיורים זהים. אין צורך להחליף אותם בקבצים שנבחרו מתוך יצוא טקסטים אחר.

בהפצה שנבדקה נמצאו גם תגי `img` בלי `src`, ותגים בעלי `src` ריק. אלה חסרים במקור עצמו, ולא כשל בהורדת תמונה שהאתר יודע את כתובתה. יש לשמר במקום כזה חיווי גלוי ולדווח במניפסט על החוסר במקור. אין להציג יצוא של תג ריק כהשלמה של איור שאינו קיים בהפצה.

בבדיקת ההפצה `v39-20261119190809` נמצאו 1,670 מופעי תמונה ב-234 ספרים ומהדורות. מתוכם 1,588 כוללים תמונה מוטמעת הניתנת לשחזור ו-82 חסרים כתובת במקור. לאחר איחוד קבצים זהים התקבלו 1,358 קובצי PNG/JPEG, בנפח 54,527,251 בתים. שבע הצהרות MIME לא תאמו לבתי התמונה; סוג הקובץ נקבע לפי חתימת הקובץ, וההצהרה המקורית נשמרה במטאדאטה. אלה נתוני הבדיקה של אותה הפצה, ולא מכסה או מספר ספרים קבוע לתהליך העדכון.

### יציבות מזהים

תשתית ההפצה מתעדת במפורש שמזהי הספרים נשמרים בין גרסאות באמצעות `build_state` ו-`IdAllocator`. [חוזה העדכון של SeforimLibrary](https://github.com/Otzaria/SeforimLibrary/blob/otzaria/DELTA_UPDATE_WORKFLOW.md) ומנגנון `BookIdContinuity` מטפלים גם בשינויים בשם או במקור הספר. האתר משתמש במזהה המקור לכתובת הספר, ולא ב-hash של הטקסט המשתנה.

### מדיניות מו״לים ובאנרים

המסד עשוי להכיל `book_protection` וכן `book_banner` ו-`banner`. אלה אינם כללי החרגה של ספרים מהקטלוג או מהקורא הרגיל. [`BookProtection`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/book_protection/models/book_protection.dart) מגדיר הגבלות על פעולות: ברמה 1 היישום מונע ייצוא לפורמט הניתן לעריכה ומגביל פעולת העתקה ל-40 שורות; ברמה 2 הוא מגביל גם הדפסה ל-40 שורות ומונע ייצוא PDF. הספר עצמו ממשיך להופיע ולהיקרא.

בנפרד, [`plugin_bridge_adapter.dart`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/plugins/bridge/plugin_bridge_adapter.dart) אינו מוסר לתוספים את הטקסט המלא של ספר עם הגבלה. לכן אין להסיק מהתנהגות ממשק התוספים שספר כזה נעדר מהספרייה הרשמית, ואין להציג את אתר האינטרנט כמימוש זהה של הגבלות ההעתקה של תוכנת שולחן העבודה.

האתר נבנה כפרויקט הרשמי ובהרשאה שניתנה לפרסום כל התוכן. אין סינון של ספרי המסד לפי שדות אלה. יש לשמר את רמת המדיניות ואת הודעת המו״ל כמידע על המקור, לצד הייחוס והרישיון. הפונקציה [`expandBannerTitle`](https://github.com/Otzaria/otzaria/blob/cee59520a8e6d35d5350b8f51cde322d4b4b99cf/lib/book_protection/utils/banner_title.dart) מרחיבה את `{title}` בשם הספר, עם קידוד כתובת כאשר הוא מופיע ביעד של קישור. גם מהדורה חלופית יורשת את מדיניות הספר הראשי.

## בדיקה והפעלה

```bash
LIBRARY_PROFILE=full npm run sync
node scripts/sync-companions.mjs
```

ניתן לבדוק אם מקור צילומי הבבלי השתנה ללא הורדת הארכיון:

```bash
node scripts/sync-companions.mjs --check
```

היבוא המלא של הספרים נמצא ב-`.cache/library`. תמונת המצב של הקבצים המצורפים נמצאת ב-`.cache/companions/catalog.json` ו-`.cache/companions/pdfs/`. המניפסט כולל מקור הפצה, digest של הארכיון, digest לכל PDF, שם הקובץ המקורי ומזהה יציב לפי שם המסכת.

מספר הספרים והקבצים המדויק מתפרסם בפלט הבנייה. מידע זה עדיף על מספר קבוע ב-README, שיתיישן כאשר יתווספו תכנים.
