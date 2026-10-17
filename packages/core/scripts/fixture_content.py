"""Text content of the synthetic PDF fixtures (M1.1).

Everything here was written for this repository as test data. It is not taken from any book,
article or exam; numbers in tables are illustrative only. The Korean and English books describe
the same concepts with the same section ids so that KO<->EN retrieval can be evaluated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

SYNTHETIC_MARKER_KO = "소프트웨어 테스트를 위해 작성된 합성 자료"
SYNTHETIC_MARKER_EN = "synthetic material written for software testing"


@dataclass(frozen=True)
class Para:
    id: str
    text: str


@dataclass(frozen=True)
class Figure:
    id: str
    caption_id: str
    caption: str
    height: float = 120.0


@dataclass(frozen=True)
class Table:
    id: str
    caption_id: str
    caption: str
    rows: tuple[tuple[str, ...], ...]
    header_rows: int = 1


BodyItem = Para | Figure | Table


@dataclass(frozen=True)
class SectionContent:
    id: str
    title: str
    body: tuple[BodyItem, ...]


@dataclass(frozen=True)
class ChapterContent:
    id: str
    title: str
    intro: tuple[BodyItem, ...]
    sections: tuple[SectionContent, ...]


@dataclass(frozen=True)
class BookContent:
    fixture_id: str
    language: str
    title: str
    subtitle: str
    toc_heading: str
    running_header: str
    chapters: tuple[ChapterContent, ...]
    source_note: Para


BOOK_KO = BookContent(
    fixture_id="book-ko",
    language="ko",
    title="물의 순환과 정수 처리",
    subtitle=f"{SYNTHETIC_MARKER_KO} · 발췌본",
    toc_heading="목차",
    running_header="물의 순환과 정수 처리 · 합성 테스트 문서",
    chapters=(
        ChapterContent(
            id="ch1",
            title="1장 물의 순환",
            intro=(
                Para(
                    "ch1-p1",
                    "지구의 물은 바다, 대기, 육지 사이를 끊임없이 이동한다. 이 장에서는 물이 "
                    "형태를 바꾸며 이동하는 과정을 단계별로 살펴보고, 각 단계가 일상생활과 "
                    "어떻게 연결되는지 설명한다.",
                ),
            ),
            sections=(
                SectionContent(
                    id="ch1-s1",
                    title="1.1 증발과 응결",
                    body=(
                        Para(
                            "ch1-s1-p1",
                            "햇빛이 바다와 호수의 표면을 데우면 물 분자의 일부가 에너지를 얻어 "
                            "수증기가 된다. 이 과정을 증발이라고 한다. 식물의 잎에서도 물이 "
                            "수증기로 빠져나가는데, 이를 증산이라고 부르며 증발과 함께 대기 중 "
                            "수증기의 주요 공급원이 된다.",
                        ),
                        Para(
                            "ch1-s1-p2",
                            "수증기를 포함한 공기가 위로 올라가면 주변 기압이 낮아져 공기가 "
                            "팽창하고 온도가 내려간다. 온도가 이슬점 아래로 떨어지면 수증기는 "
                            "먼지나 소금 알갱이 같은 작은 입자를 중심으로 모여 물방울이 된다. "
                            "이 과정을 응결이라고 하며, 수많은 물방울이 모인 것이 구름이다.",
                        ),
                        Figure(
                            "ch1-s1-fig1",
                            "ch1-s1-fig1-caption",
                            "그림 1. 물 순환 모식도 (자리표시자)",
                        ),
                        Para(
                            "ch1-s1-p3",
                            "응결은 열을 방출하는 과정이기도 하다. 수증기가 물방울로 바뀔 때 "
                            "내놓는 열은 주변 공기를 데워 상승 기류를 강하게 만들고, 그 결과 "
                            "구름이 더 높이 발달할 수 있다. 여름철 오후에 갑자기 소나기가 내리는 "
                            "현상도 이러한 과정과 관련이 있다.",
                        ),
                    ),
                ),
                SectionContent(
                    id="ch1-s2",
                    title="1.2 강수와 유출",
                    body=(
                        Para(
                            "ch1-s2-p1",
                            "구름 속 물방울이 서로 부딪히며 합쳐져 충분히 무거워지면 비나 눈이 "
                            "되어 땅으로 떨어진다. 이를 강수라고 한다. 기온에 따라 강수의 형태가 "
                            "달라지며, 같은 구름에서도 지표 부근의 온도가 낮으면 눈이, 높으면 "
                            "비가 내린다.",
                        ),
                        Para(
                            "ch1-s2-p2",
                            "지표에 도달한 빗물의 일부는 흙 속으로 스며들어 지하수가 되고, "
                            "나머지는 경사를 따라 흘러 하천으로 모인다. 땅속으로 스며드는 과정을 "
                            "침투라고 하며, 지표 위를 흐르는 물을 유출이라고 한다. 숲이나 습지처럼 "
                            "토양이 부드러운 곳에서는 침투량이 많고, 포장된 도로가 많은 도시에서는 "
                            "유출량이 크게 늘어난다. 그래서 도시에서는 빗물을 잠시 모아 두는 "
                            "저류 시설이나 물이 스며드는 포장재를 사용해 "
                            "갑작스러운 홍수를 줄이려고 노력한다.",
                        ),
                        Para(
                            "ch1-s2-p3",
                            "하천과 지하수는 결국 다시 바다로 흘러가고, 바다의 물은 또다시 "
                            "증발한다. 이처럼 물은 형태와 장소를 바꾸며 끝없이 순환하기 때문에 "
                            "지구 전체의 물의 양은 거의 일정하게 유지된다.",
                        ),
                    ),
                ),
            ),
        ),
        ChapterContent(
            id="ch2",
            title="2장 정수 처리",
            intro=(
                Para(
                    "ch2-p1",
                    "하천이나 호수에서 얻은 원수에는 흙 알갱이, 유기물, 미생물이 섞여 있어 "
                    "그대로 마시기 어렵다. 정수장은 여러 단계를 거쳐 이러한 물질을 제거하고 "
                    "마실 수 있는 물을 만든다.",
                ),
            ),
            sections=(
                SectionContent(
                    id="ch2-s1",
                    title="2.1 응집과 침전",
                    body=(
                        Para(
                            "ch2-s1-p1",
                            "원수에 응집제를 넣고 천천히 저어 주면 물속의 아주 작은 입자들이 "
                            "서로 달라붙어 눈에 보이는 덩어리가 된다. 이 덩어리를 플록이라고 "
                            "부르며, 이 단계를 응집이라고 한다. 입자가 너무 작으면 가라앉지 "
                            "않기 때문에 응집은 다음 단계의 효율을 결정한다.",
                        ),
                        Para(
                            "ch2-s1-p2",
                            "플록이 생긴 물은 넓고 깊은 침전지로 옮겨져 몇 시간 동안 머문다. "
                            "이때 무거워진 플록이 바닥으로 가라앉고 위쪽의 맑은 물만 다음 단계로 "
                            "넘어간다. 바닥에 쌓인 침전물은 주기적으로 걷어 내어 따로 처리한다.",
                        ),
                        Table(
                            "ch2-s1-table1",
                            "ch2-s1-table1-caption",
                            "표 1. 정수 처리 단계별 예시 (합성 데이터)",
                            (
                                ("단계", "주요 작용", "예시 체류 시간"),
                                ("응집", "미세 입자 결합", "약 30분"),
                                ("침전", "플록 가라앉힘", "약 3시간"),
                                ("여과", "남은 입자 제거", "약 1시간"),
                                ("소독", "미생물 억제", "약 30분"),
                            ),
                        ),
                    ),
                ),
                SectionContent(
                    id="ch2-s2",
                    title="2.2 여과와 소독",
                    body=(
                        Para(
                            "ch2-s2-p1",
                            "침전을 거친 물은 모래와 자갈을 여러 층으로 쌓은 여과지를 통과한다. "
                            "여과층은 침전지에서 가라앉지 않은 작은 입자를 걸러 내며, 일정 "
                            "기간마다 물을 거꾸로 흘려보내 여과층을 씻어 준다.",
                        ),
                        Para(
                            "ch2-s2-p2",
                            "마지막으로 염소와 같은 소독제를 넣어 남아 있는 병원성 미생물을 "
                            "줄인다. 염소는 수도관을 따라 이동하는 동안에도 소독 효과가 "
                            "유지된다는 장점이 있지만, 너무 많이 넣으면 냄새가 날 수 있으므로 "
                            "농도를 세심하게 조절해야 한다.",
                        ),
                    ),
                ),
            ),
        ),
    ),
    source_note=Para(
        "source-note",
        f"출처: 이 문서는 {SYNTHETIC_MARKER_KO}이다. 본문과 표의 수치는 설명을 위한 "
        "예시이며 실제 출판물이나 통계에서 인용하지 않았다.",
    ),
)

BOOK_EN = BookContent(
    fixture_id="book-en",
    language="en",
    title="The Water Cycle and Water Treatment",
    subtitle=f"An excerpt of {SYNTHETIC_MARKER_EN}",
    toc_heading="Contents",
    running_header="The Water Cycle and Water Treatment · Synthetic test document",
    chapters=(
        ChapterContent(
            id="ch1",
            title="Chapter 1. The Water Cycle",
            intro=(
                Para(
                    "ch1-p1",
                    "Water on Earth moves constantly between the oceans, the atmosphere and the "
                    "land. This chapter follows that journey step by step and explains how each "
                    "step connects to everyday life.",
                ),
            ),
            sections=(
                SectionContent(
                    id="ch1-s1",
                    title="1.1 Evaporation and Condensation",
                    body=(
                        Para(
                            "ch1-s1-p1",
                            "When sunlight warms the surface of seas and lakes, some water "
                            "molecules gain enough energy to become water vapor. This process is "
                            "called evaporation. Plants also release water vapor through their "
                            "leaves; this is called transpiration, and together with evaporation "
                            "it is the main source of moisture in the air.",
                        ),
                        Para(
                            "ch1-s1-p2",
                            "As moist air rises, the surrounding pressure drops, so the air "
                            "expands and cools. Once its temperature falls below the dew point, "
                            "the vapor gathers around tiny particles such as dust or sea salt and "
                            "forms droplets. This process is called condensation, and a cloud is "
                            "simply a huge number of these droplets.",
                        ),
                        Figure(
                            "ch1-s1-fig1",
                            "ch1-s1-fig1-caption",
                            "Figure 1. Diagram of the water cycle (placeholder)",
                        ),
                        Para(
                            "ch1-s1-p3",
                            "Condensation also releases heat. The heat given off when vapor turns "
                            "into droplets warms the surrounding air and strengthens the updraft, "
                            "which lets clouds grow taller. Sudden showers on summer afternoons "
                            "are closely related to this process.",
                        ),
                    ),
                ),
                SectionContent(
                    id="ch1-s2",
                    title="1.2 Precipitation and Runoff",
                    body=(
                        Para(
                            "ch1-s2-p1",
                            "Droplets inside a cloud collide and merge, and when they become heavy "
                            "enough they fall to the ground as rain or snow. This is called "
                            "precipitation. Its form depends on temperature: the same cloud may "
                            "produce snow when the air near the ground is cold and rain when it "
                            "is warm.",
                        ),
                        Para(
                            "ch1-s2-p2",
                            "Part of the rain that reaches the ground soaks into the soil and "
                            "becomes groundwater, while the rest flows downhill into streams. "
                            "Soaking into the ground is called infiltration, and water flowing "
                            "over the surface is called runoff. Soft soils in forests and "
                            "wetlands allow a lot of infiltration, whereas cities covered with "
                            "paved roads produce much more runoff. For this reason cities build "
                            "detention basins that hold rainwater for a while and use permeable "
                            "pavement to reduce sudden floods.",
                        ),
                        Para(
                            "ch1-s2-p3",
                            "Rivers and groundwater eventually flow back to the sea, and sea water "
                            "evaporates again. Because water keeps changing its form and place in "
                            "an endless cycle, the total amount of water on Earth stays almost "
                            "constant.",
                        ),
                    ),
                ),
            ),
        ),
        ChapterContent(
            id="ch2",
            title="Chapter 2. Water Treatment",
            intro=(
                Para(
                    "ch2-p1",
                    "Raw water taken from rivers or lakes contains soil particles, organic "
                    "matter and microorganisms, so it is not safe to drink as it is. A water "
                    "treatment plant removes these substances in several stages to produce "
                    "drinking water.",
                ),
            ),
            sections=(
                SectionContent(
                    id="ch2-s1",
                    title="2.1 Coagulation and Sedimentation",
                    body=(
                        Para(
                            "ch2-s1-p1",
                            "When a coagulant is added to raw water and the water is stirred "
                            "slowly, very small particles stick together and form visible clumps. "
                            "These clumps are called flocs, and this stage is called coagulation. "
                            "Particles that are too small never settle, so coagulation determines "
                            "how well the next stage works.",
                        ),
                        Para(
                            "ch2-s1-p2",
                            "The water with flocs is moved into wide, deep sedimentation basins "
                            "where it stays for several hours. The heavy flocs sink to the bottom "
                            "and only the clear water on top moves on to the next stage. The "
                            "sludge collected at the bottom is removed regularly and treated "
                            "separately.",
                        ),
                        Table(
                            "ch2-s1-table1",
                            "ch2-s1-table1-caption",
                            "Table 1. Example treatment stages (synthetic data)",
                            (
                                ("Stage", "Main action", "Example retention time"),
                                ("Coagulation", "Binds fine particles", "about 30 min"),
                                ("Sedimentation", "Settles flocs", "about 3 h"),
                                ("Filtration", "Removes remaining particles", "about 1 h"),
                                ("Disinfection", "Suppresses microbes", "about 30 min"),
                            ),
                        ),
                    ),
                ),
                SectionContent(
                    id="ch2-s2",
                    title="2.2 Filtration and Disinfection",
                    body=(
                        Para(
                            "ch2-s2-p1",
                            "After sedimentation the water passes through filter beds made of "
                            "layers of sand and gravel. The filter catches small particles that "
                            "did not settle, and it is cleaned regularly by pumping water through "
                            "it in the opposite direction.",
                        ),
                        Para(
                            "ch2-s2-p2",
                            "Finally a disinfectant such as chlorine is added to reduce the "
                            "remaining pathogenic microorganisms. Chlorine keeps working while the "
                            "water travels through the pipes, but too much of it causes an "
                            "unpleasant smell, so its concentration must be controlled carefully.",
                        ),
                    ),
                ),
            ),
        ),
    ),
    source_note=Para(
        "source-note",
        f"Source: this document is {SYNTHETIC_MARKER_EN}. The text and the numbers in the table "
        "are illustrative examples and are not quoted from any publication or statistics.",
    ),
)


OptionStyle = Literal["circled", "latin"]
QuestionKind = Literal["MCQ", "SHORT_ANSWER", "ESSAY"]

CIRCLED_LABELS = ("①", "②", "③", "④")
LATIN_LABELS = ("A", "B", "C", "D")


@dataclass(frozen=True)
class QuestionContent:
    number: int
    kind: QuestionKind
    stem: str
    options: tuple[str, ...] = ()
    option_style: OptionStyle | None = None
    multi_select: bool = False
    # Printed in the answer key; None means the paper does not provide an answer.
    key_labels: tuple[str, ...] | None = None
    key_text: str | None = None
    figure_caption: str | None = None

    @property
    def labels(self) -> tuple[str, ...]:
        if self.option_style == "circled":
            return CIRCLED_LABELS[: len(self.options)]
        if self.option_style == "latin":
            return LATIN_LABELS[: len(self.options)]
        return ()


@dataclass(frozen=True)
class QuestionPaperContent:
    fixture_id: str
    language: str
    title: str
    instructions: str
    running_header: str
    answer_key_heading: str
    questions: tuple[QuestionContent, ...] = field(default_factory=tuple)


QUESTIONS_KO = QuestionPaperContent(
    fixture_id="questions-ko",
    language="ko",
    title="제1회 합성 확인 평가 — 물의 순환과 정수 처리",
    instructions=f"※ 이 평가지는 {SYNTHETIC_MARKER_KO}입니다. 다음 물음에 답하시오.",
    running_header="합성 확인 평가 · 테스트용",
    answer_key_heading="정답",
    questions=(
        QuestionContent(
            1,
            "MCQ",
            "물이 액체에서 기체로 변하는 과정을 무엇이라 하는가?",
            ("응결", "증발", "강수", "침전"),
            "circled",
            key_labels=("②",),
        ),
        QuestionContent(
            2,
            "MCQ",
            "다음 중 정수 처리 단계에 해당하는 것을 모두 고르시오.",
            ("응집", "증산", "여과", "소독"),
            "latin",
            multi_select=True,
            key_labels=("A", "C", "D"),
        ),
        QuestionContent(
            3,
            "MCQ",
            "[그림 1]에서 바다 표면의 물이 대기로 이동하는 과정으로 가장 알맞은 것은?",
            ("유출", "응결", "증발", "침투"),
            "circled",
            figure_caption="[그림 1] 물 순환 단면 모식도 (자리표시자)",
        ),
        QuestionContent(
            4,
            "SHORT_ANSWER",
            "수증기가 냉각되어 작은 물방울로 변하는 과정을 쓰시오.",
            key_text="응결",
        ),
        QuestionContent(
            5,
            "MCQ",
            "염소 소독의 주된 목적으로 옳은 것은?",
            (
                "물의 색을 진하게 한다.",
                "병원성 미생물을 줄인다.",
                "물의 온도를 높인다.",
                "침전물의 양을 늘린다.",
            ),
            "circled",
            key_labels=("②",),
        ),
        QuestionContent(
            6,
            "SHORT_ANSWER",
            "모래와 자갈 층을 통과시켜 작은 입자를 걸러 내는 정수 단계의 이름을 쓰시오.",
        ),
        QuestionContent(
            7,
            "ESSAY",
            "도시화가 지표면 유출량에 미치는 영향을 침투와 관련지어 서술하시오.",
        ),
        QuestionContent(
            8,
            "MCQ",
            "응집 단계에 대한 설명으로 옳은 것을 모두 고르시오.",
            (
                "응집제는 물을 빠르게 증발시킨다.",
                "작은 입자들이 달라붙어 플록이 된다.",
                "응집은 소독 이후에 진행된다.",
                "응집이 잘 되어야 침전 효율이 높아진다.",
            ),
            "latin",
            multi_select=True,
            key_labels=("B", "D"),
        ),
    ),
)


@dataclass(frozen=True)
class RetrievalQueryContent:
    id: str
    language: str
    query: str
    # (fixture_id, section_id, graded relevance 1..3)
    relevant: tuple[tuple[str, str, int], ...]


def _both(section_id: str, grade: int = 2) -> tuple[tuple[str, str, int], ...]:
    return (("book-ko", section_id, grade), ("book-en", section_id, grade))


RETRIEVAL_SEED = (
    RetrievalQueryContent("q-ko-01", "ko", "정수장에서 염소를 넣는 이유", _both("ch2-s2")),
    RetrievalQueryContent("q-ko-02", "ko", "빗물이 땅속으로 스며드는 과정", _both("ch1-s2")),
    RetrievalQueryContent("q-ko-03", "ko", "구름은 어떻게 만들어지나", _both("ch1-s1")),
    RetrievalQueryContent(
        "q-en-01", "en", "why is a coagulant added before sedimentation", _both("ch2-s1")
    ),
    RetrievalQueryContent(
        "q-en-02", "en", "how do paved cities change surface runoff", _both("ch1-s2")
    ),
    RetrievalQueryContent(
        "q-en-03", "en", "retention time of each water treatment stage", _both("ch2-s1")
    ),
)


def all_strings() -> list[str]:
    """Every string drawn into any fixture; drives font subsetting and coverage checks."""
    out: list[str] = []
    for book in (BOOK_KO, BOOK_EN):
        out += [book.title, book.subtitle, book.toc_heading, book.running_header]
        out.append(book.source_note.text)
        for chapter in book.chapters:
            out.append(chapter.title)
            items: list[BodyItem] = list(chapter.intro)
            for section in chapter.sections:
                out.append(section.title)
                items += section.body
            for item in items:
                if isinstance(item, Para):
                    out.append(item.text)
                elif isinstance(item, Figure):
                    out.append(item.caption)
                else:
                    out.append(item.caption)
                    out += [cell for row in item.rows for cell in row]
    paper = QUESTIONS_KO
    out += [paper.title, paper.instructions, paper.running_header, paper.answer_key_heading]
    for q in paper.questions:
        out += [q.stem, *q.options, *q.labels, *(q.key_labels or ())]
        if q.key_text:
            out.append(q.key_text)
        if q.figure_caption:
            out.append(q.figure_caption)
    return out


def heading_strings() -> list[str]:
    """Strings drawn in the bold face (titles and headings)."""
    out: list[str] = []
    for book in (BOOK_KO, BOOK_EN):
        out += [book.title, book.toc_heading]
        for chapter in book.chapters:
            out.append(chapter.title)
            for section in chapter.sections:
                out.append(section.title)
                for item in section.body:
                    if isinstance(item, Table):
                        out += [cell for row in item.rows[: item.header_rows] for cell in row]
    out += [QUESTIONS_KO.title, QUESTIONS_KO.answer_key_heading]
    return out
